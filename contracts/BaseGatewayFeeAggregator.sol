// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IGatewayWallet {
    function depositFor(address token, address depositor, uint256 value) external;
}

/// @notice Atomically collects the service fee and deposits USDC into Circle Gateway.
/// @dev This deployment is Base-specific because its token and Gateway addresses are immutable.
contract BaseGatewayFeeAggregator {
    uint256 public constant FEE_BPS = 50;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdc;
    IGatewayWallet public immutable gatewayWallet;
    address public immutable feeRecipient;

    uint256 private locked = 1;

    event DepositedWithFee(
        address indexed depositor,
        uint256 depositAmount,
        uint256 serviceFee,
        address indexed feeRecipient
    );
    event FeePaid(address indexed payer, uint256 indexed bridgeAmount, uint256 serviceFee);

    error ReentrantCall();
    error ZeroAmount();
    error TokenOperationFailed();

    constructor(address usdc_, address gatewayWallet_, address feeRecipient_) {
        usdc = IERC20(usdc_);
        gatewayWallet = IGatewayWallet(gatewayWallet_);
        feeRecipient = feeRecipient_;
    }

    /// @param depositAmount USDC credited to msg.sender's Circle Gateway balance.
    function depositWithFee(uint256 depositAmount) external {
        if (locked != 1) revert ReentrantCall();
        if (depositAmount == 0) revert ZeroAmount();
        locked = 2;

        uint256 serviceFee = _serviceFee(depositAmount);
        uint256 totalAmount = depositAmount + serviceFee;

        if (!usdc.transferFrom(msg.sender, address(this), totalAmount)) {
            revert TokenOperationFailed();
        }
        if (!usdc.transfer(feeRecipient, serviceFee)) {
            revert TokenOperationFailed();
        }
        if (!usdc.approve(address(gatewayWallet), depositAmount)) {
            revert TokenOperationFailed();
        }

        gatewayWallet.depositFor(address(usdc), msg.sender, depositAmount);

        // Avoid leaving a reusable allowance if a non-standard Gateway implementation
        // does not consume the full approved amount.
        if (!usdc.approve(address(gatewayWallet), 0)) {
            revert TokenOperationFailed();
        }

        emit DepositedWithFee(msg.sender, depositAmount, serviceFee, feeRecipient);
        locked = 1;
    }

    function totalFor(uint256 depositAmount) external pure returns (uint256) {
        return depositAmount + _serviceFee(depositAmount);
    }

    /// @notice Collects only the fee when the user already has finalized Gateway balance.
    function payFee(uint256 bridgeAmount) external {
        if (locked != 1) revert ReentrantCall();
        if (bridgeAmount == 0) revert ZeroAmount();
        locked = 2;

        uint256 serviceFee = _serviceFee(bridgeAmount);
        if (!usdc.transferFrom(msg.sender, feeRecipient, serviceFee)) {
            revert TokenOperationFailed();
        }

        emit FeePaid(msg.sender, bridgeAmount, serviceFee);
        locked = 1;
    }

    function _serviceFee(uint256 depositAmount) private pure returns (uint256) {
        // Round up to the nearest USDC base unit, matching the frontend.
        return (depositAmount * FEE_BPS + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
    }
}
