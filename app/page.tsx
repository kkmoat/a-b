"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  maxUint256,
  pad,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
      on?(event: string, handler: (...args: unknown[]) => void): void;
      removeListener?(event: string, handler: (...args: unknown[]) => void): void;
    };
  }
}

const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const GATEWAY_WALLET = getAddress("0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE");
const GATEWAY_MINTER = getAddress("0x2222222d7164433c4C09B0b0D809a9b52C04C205");
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const SERVICE_FEE_BPS = 50n;
const BPS_DENOMINATOR = 10_000n;
const CIRCLE_FEE_RESERVE = 10_000n; // 0.01 USDC in 6-decimal base units.
const FEE_AGGREGATOR_STORAGE_KEY = "arc-bridge-fee-aggregator";
const configuredFeeAggregator = process.env.NEXT_PUBLIC_FEE_AGGREGATOR_ADDRESS;
const FEE_AGGREGATOR = configuredFeeAggregator
  ? getAddress(configuredFeeAggregator)
  : undefined;
const BASE_DOMAIN = 6;
const ARC_DOMAIN = 26;
const ARC_CHAIN_ID = 5042;
const MAX_FEE_FALLBACK = 5_000_000n;

const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Mainnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.blockdaemon.mainnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const feeAggregatorAbi = [
  {
    type: "function",
    name: "depositWithFee",
    stateMutability: "nonpayable",
    inputs: [{ name: "depositAmount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "payFee",
    stateMutability: "nonpayable",
    inputs: [{ name: "bridgeAmount", type: "uint256" }],
    outputs: [],
  },
] as const;

const feeAggregatorDeploymentAbi = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "usdc_", type: "address" },
      { name: "gatewayWallet_", type: "address" },
      { name: "feeRecipient_", type: "address" },
    ],
  },
] as const;

const gatewayMinterAbi = [
  {
    type: "function",
    name: "gatewayMint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
] as const;

const TransferSpec = [
  { name: "version", type: "uint32" },
  { name: "sourceDomain", type: "uint32" },
  { name: "destinationDomain", type: "uint32" },
  { name: "sourceContract", type: "bytes32" },
  { name: "destinationContract", type: "bytes32" },
  { name: "sourceToken", type: "bytes32" },
  { name: "destinationToken", type: "bytes32" },
  { name: "sourceDepositor", type: "bytes32" },
  { name: "destinationRecipient", type: "bytes32" },
  { name: "sourceSigner", type: "bytes32" },
  { name: "destinationCaller", type: "bytes32" },
  { name: "value", type: "uint256" },
  { name: "salt", type: "bytes32" },
  { name: "hookData", type: "bytes" },
] as const;

const BurnIntent = [
  { name: "maxBlockHeight", type: "uint256" },
  { name: "maxFee", type: "uint256" },
  { name: "spec", type: "TransferSpec" },
] as const;

type Stage =
  | "connect"
  | "ready"
  | "approving"
  | "depositing"
  | "finalizing"
  | "ready_to_continue"
  | "interrupted"
  | "charging"
  | "estimating"
  | "signing"
  | "attesting"
  | "minting"
  | "success"
  | "error";

type Locale = "en" | "zh";

type ActivityRecord = {
  id: string;
  wallet: Address;
  amount: string;
  stage: Stage;
  depositHash?: Hex;
  mintHash?: Hex;
  transferId?: string;
  attestationPayload?: Hex;
  attestationSignature?: Hex;
  feeHash?: Hex;
  serviceFee?: string;
  baseDepositStatus?: "pending" | "success" | "failed";
  baseConfirmedAt?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const ACTIVITY_STORAGE_KEY = "arc-bridge-activity-v1";
const LOCALE_STORAGE_KEY = "arc-bridge-locale";

const copy = {
  en: {
    bridge: "Bridge", activity: "Activity", docs: "Docs", connect: "Connect Wallet",
    connectedWallet: "Connected wallet", disconnect: "Disconnect",
    eyebrow: "Base → Arc", from: "From", to: "To",
    youSend: "You send", amountLabel: "USDC amount", baseBalance: "Base balance",
    route: "Route", available: "Gateway available", fee: "Estimated fee",
    serviceFee: "Service fee (0.5%)", feeTransaction: "Service fee ↗",
    circleReserve: "Circle fee reserve",
    aggregatorMissing: "The fee aggregator contract has not been deployed or configured.",
    deployAggregator: "Deploy aggregator", deployingAggregator: "Deploying aggregator…",
    aggregatorReady: "Aggregator deployed",
    continueTransfer: "Continue transfer", baseConfirming: "Base confirming",
    baseSucceeded: "Base deposit succeeded", baseFailed: "Base deposit failed",
    circleWaiting: "Waiting for Circle finality · Estimated 15–20 minutes",
    estimatedProgress: "Estimated Circle progress",
    gatewayReady: (amount: string) => `${amount} USDC is ready in Gateway. Choose an amount to continue directly to signing.`,
    gatewayPromptTitle: "Gateway balance ready",
    gatewayPromptBody: "This finalized balance can be bridged directly without another Base deposit.",
    useGatewayBalance: "Use available balance",
    deposit: "Deposit", sign: "Sign BurnIntent", mint: "Mint on Arc",
    complete: "Transfer complete", transferStatus: "Transfer status",
    baseDeposit: "Base deposit ↗", arcMint: "Arc mint ↗", gatewayId: "Gateway ID",
    powered: "By", activityTitle: "Activity",
    activitySubtitle: "Saved in this browser so your bridge history remains available after refresh.",
    empty: "No bridge activity yet.", statusLabel: "Status", started: "Started",
    before: "Before you bridge", safety: "Verify every wallet prompt and test with a small amount first.",
    localNote: "Activity is stored locally on this device. Clearing browser data will remove it.",
    ready: "Connect your wallet to begin.", connected: "Wallet connected. Enter an amount to bridge.",
    noWallet: "No injected wallet found. Install MetaMask, Rabby, or Coinbase Wallet.",
    invalidAmount: "Enter a valid USDC amount.", insufficient: "Insufficient balance for the bridge amount plus the 0.5% service fee.",
    approveStatus: "Approve Circle GatewayWallet in your wallet.", depositStatus: "Confirm the Gateway deposit on Base.",
    finalizingStatus: "Deposit confirmed on Base. Waiting for Circle finality…",
    estimatingStatus: "Requesting Circle’s transfer quote.",
    signingStatus: "Review and sign the Circle BurnIntent. This signature does not expose your key.",
    attestingStatus: "Submitting your signed intent to Circle Gateway.",
    mintingStatus: "Switching to Arc. Confirm gatewayMint in your wallet.",
    feeStatus: (amount: string) => `Confirm the ${amount} USDC service fee transfer on Base.`,
    successStatus: (amount: string) => `${amount} USDC was minted successfully on Arc.`,
    safeError: "Your progress is saved. Resolve the issue and retry.",
    newReady: "Ready for a new Base → Arc transfer.",
    pendingDeposit: (amount: string) => `Circle is finalizing ${amount || "your"} USDC deposit on Base.`,
    another: "Bridge another transfer", approveBridge: "Approve & Bridge USDC", bridgeUsdc: "Bridge USDC",
    approving: "Approving USDC…", depositing: "Depositing on Base…", waiting: "Waiting for Circle finality…",
    estimating: "Getting quote…", signing: "Sign BurnIntent…", attesting: "Getting attestation…", minting: "Minting on Arc…",
  },
  zh: {
    bridge: "跨链", activity: "历史", docs: "文档", connect: "连接钱包",
    connectedWallet: "已连接钱包", disconnect: "断开连接",
    eyebrow: "Base → Arc", from: "从", to: "到",
    youSend: "发送数量", amountLabel: "USDC 数量", baseBalance: "Base 余额",
    route: "跨链路径", available: "Gateway 可用余额", fee: "预计费用",
    serviceFee: "服务费（0.5%）", feeTransaction: "服务费交易 ↗",
    circleReserve: "Circle 费用预留",
    aggregatorMissing: "手续费聚合合约尚未部署或配置。",
    deployAggregator: "部署聚合合约", deployingAggregator: "正在部署聚合合约…",
    aggregatorReady: "聚合合约已部署",
    continueTransfer: "继续跨链", baseConfirming: "Base 确认中",
    baseSucceeded: "Base 充值成功", baseFailed: "Base 充值失败",
    circleWaiting: "等待 Circle 确认中 · 预计 15–20 分钟",
    estimatedProgress: "Circle 预计确认进度",
    gatewayReady: (amount: string) => `Gateway 中已有 ${amount} USDC 可用，请选择数量直接进入签名流程。`,
    gatewayPromptTitle: "Gateway 余额已就绪",
    gatewayPromptBody: "该余额已完成确认，无需再次在 Base 充值，可直接继续跨链。",
    useGatewayBalance: "使用可用余额",
    deposit: "充值", sign: "签署 BurnIntent", mint: "在 Arc 铸造",
    complete: "跨链完成", transferStatus: "跨链状态",
    baseDeposit: "Base 充值交易 ↗", arcMint: "Arc 铸造交易 ↗", gatewayId: "Gateway 编号",
    powered: "By", activityTitle: "历史",
    activitySubtitle: "记录保存在此浏览器中，刷新或重新打开页面后仍可查看。",
    empty: "暂无跨链记录。", statusLabel: "状态", started: "开始时间",
    before: "跨链前请注意", safety: "请核对每一次钱包签名，并先使用小额资产测试。",
    localNote: "活动记录仅保存在当前设备；清除浏览器数据会同时删除记录。",
    ready: "连接钱包后即可开始。", connected: "钱包已连接，请输入跨链数量。",
    noWallet: "未检测到钱包，请安装 MetaMask、Rabby 或 Coinbase Wallet。",
    invalidAmount: "请输入有效的 USDC 数量。", insufficient: "余额不足以支付跨链数量及额外的 0.5% 服务费。",
    approveStatus: "请在钱包中授权 Circle GatewayWallet。", depositStatus: "请确认 Base 上的 Gateway 充值交易。",
    finalizingStatus: "Base 充值已确认，正在等待 Circle 最终确认…",
    estimatingStatus: "正在获取 Circle 跨链报价。",
    signingStatus: "请检查并签署 Circle BurnIntent，此签名不会暴露您的私钥。",
    attestingStatus: "正在向 Circle Gateway 提交已签署的意图。",
    mintingStatus: "正在切换至 Arc，请在钱包中确认 gatewayMint。",
    feeStatus: (amount: string) => `请在 Base 上确认 ${amount} USDC 服务费转账。`,
    successStatus: (amount: string) => `${amount} USDC 已成功在 Arc 上铸造。`,
    safeError: "跨链进度已保存，请解决问题后重试。",
    newReady: "已准备好进行新的 Base → Arc 跨链。",
    pendingDeposit: (amount: string) => `Circle 正在确认 Base 上 ${amount || "您的"} USDC 充值。`,
    another: "发起另一笔跨链", approveBridge: "授权并跨链 USDC", bridgeUsdc: "跨链 USDC",
    approving: "正在授权 USDC…", depositing: "正在充值至 Base…", waiting: "等待 Circle 确认…",
    estimating: "正在获取报价…", signing: "签署 BurnIntent…", attesting: "正在获取证明…", minting: "正在 Arc 铸造…",
  },
} as const;

const stageLabels: Record<Locale, Record<Stage, string>> = {
  en: { connect: "Not started", ready: "Ready", approving: "Approving", depositing: "Depositing", finalizing: "Waiting for Circle", ready_to_continue: "Ready to continue", interrupted: "Interrupted · resumable", charging: "Collecting fee", estimating: "Quoting", signing: "Awaiting signature", attesting: "Attesting", minting: "Minting", success: "Completed", error: "Failed" },
  zh: { connect: "未开始", ready: "准备就绪", approving: "授权中", depositing: "充值中", finalizing: "等待 Circle 确认", ready_to_continue: "可以继续", interrupted: "已中断 · 可以继续", charging: "收取服务费", estimating: "报价中", signing: "等待签名", attesting: "生成证明", minting: "铸造中", success: "已完成", error: "失败" },
};

type GatewayBalance = {
  domain?: number;
  balance?: string;
  depositor?: string;
};

type GatewayDeposit = {
  domain?: number;
  amount?: string;
  status?: string;
  transactionHash?: string;
};

type BurnIntentMessage = {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: bigint;
    salt: Hex;
    hookData: Hex;
  };
};

const baseClient = createPublicClient({ chain: base, transport: http() });
const arcClient = createPublicClient({ chain: arc, transport: http() });

function shortAddress(address?: string) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function bytes32(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 });
}

function ensureBytes32(value: Hex): Hex {
  return value.length === 66 ? value : pad(value.toLowerCase() as Hex, { size: 32 });
}

function friendlyError(cause: unknown, locale: Locale) {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const rejected =
    raw.toLowerCase().includes("user rejected") ||
    raw.toLowerCase().includes("user denied") ||
    raw.includes("4001");
  if (rejected) {
    return locale === "zh"
      ? "用户取消了钱包确认，流程已中断，可以继续。"
      : "Wallet confirmation was cancelled. The transfer is interrupted and can be resumed.";
  }
  return raw.length > 280 ? `${raw.slice(0, 277)}…` : raw;
}

function normalizeGatewayAmount(value?: string): bigint {
  if (!value) return 0n;
  if (value.includes(".")) return parseUnits(value, 6);
  return BigInt(value);
}

function mergeActivityHistory(records: ActivityRecord[]) {
  const usable = records.filter((item) => {
    const hasIdentity = Boolean(
      item.depositHash || item.feeHash || item.transferId || item.mintHash,
    );
    return hasIdentity || !["error", "interrupted"].includes(item.stage);
  });
  const groups: ActivityRecord[][] = [];
  const identifiers = (item: ActivityRecord) =>
    [item.depositHash, item.feeHash, item.transferId, item.mintHash]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

  for (const item of usable) {
    const itemIds = identifiers(item);
    const matching = groups.filter((group) =>
      group.some((existing) => {
        if (existing.wallet.toLowerCase() !== item.wallet.toLowerCase()) return false;
        const existingIds = identifiers(existing);
        return itemIds.some((id) => existingIds.includes(id));
      }),
    );
    if (!matching.length || !itemIds.length) {
      groups.push([item]);
      continue;
    }
    const combined = [item, ...matching.flat()];
    for (const group of matching) groups.splice(groups.indexOf(group), 1);
    groups.push(combined);
  }

  return groups.map((group) => {
    const chronological = [...group].sort((a, b) => a.updatedAt - b.updatedAt);
    const oldest = [...group].sort((a, b) => a.createdAt - b.createdAt)[0];
    const merged = Object.assign({}, ...chronological) as ActivityRecord;
    const hasCircleTransfer = Boolean(merged.transferId || merged.attestationPayload);
    return {
      ...merged,
      id: oldest.id,
      createdAt: oldest.createdAt,
      baseDepositStatus: hasCircleTransfer ? "success" as const : merged.baseDepositStatus,
      baseConfirmedAt:
        hasCircleTransfer ? merged.baseConfirmedAt ?? merged.updatedAt : merged.baseConfirmedAt,
    };
  }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

async function gatewayPost(endpoint: string, body: unknown) {
  const response = await fetch(`/api/gateway/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok || json?.success === false) {
    throw new Error(json?.message || json?.error || `Circle Gateway error (${response.status})`);
  }
  return json;
}

function buildDraft(address: Address, value: bigint): BurnIntentMessage {
  return {
    maxBlockHeight: maxUint256,
    maxFee: MAX_FEE_FALLBACK,
    spec: {
      version: 1,
      sourceDomain: BASE_DOMAIN,
      destinationDomain: ARC_DOMAIN,
      sourceContract: bytes32(GATEWAY_WALLET),
      destinationContract: bytes32(GATEWAY_MINTER),
      sourceToken: bytes32(BASE_USDC),
      destinationToken: bytes32(ARC_USDC),
      sourceDepositor: bytes32(address),
      destinationRecipient: bytes32(address),
      sourceSigner: bytes32(address),
      destinationCaller: bytes32(zeroAddress),
      value,
      salt: randomSalt(),
      hookData: "0x",
    },
  };
}

export default function Home() {
  const [view, setView] = useState<"bridge" | "activity">("bridge");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [feeAggregator, setFeeAggregator] = useState<Address | undefined>(FEE_AGGREGATOR);
  const [deployingAggregator, setDeployingAggregator] = useState(false);
  const [resumeActivityId, setResumeActivityId] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const [locale, setLocale] = useState<Locale>("zh");
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [address, setAddress] = useState<Address>();
  const [amount, setAmount] = useState("");
  const [baseBalance, setBaseBalance] = useState(0n);
  const [gatewayBalance, setGatewayBalance] = useState(0n);
  const [allowance, setAllowance] = useState(0n);
  const [stage, setStage] = useState<Stage>("connect");
  const [statusKey, setStatusKey] = useState<keyof typeof copy.en>("ready");
  const [statusAmount, setStatusAmount] = useState("");
  const [error, setError] = useState("");
  const [depositHash, setDepositHash] = useState<Hex>();
  const [feeHash, setFeeHash] = useState<Hex>();
  const [mintHash, setMintHash] = useState<Hex>();
  const [fee, setFee] = useState("—");
  const [transferId, setTransferId] = useState("");
  const [busy, setBusy] = useState(false);
  const t = copy[locale];
  const status = statusKey === "successStatus" || statusKey === "pendingDeposit" || statusKey === "gatewayReady" || statusKey === "feeStatus"
    ? t[statusKey](statusAmount)
    : String(t[statusKey]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const syncView = () => setView(window.location.hash === "#activity" ? "activity" : "bridge");
    syncView();
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  useEffect(() => {
    try {
      const savedLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
      const initialLocale = savedLocale === "en" || savedLocale === "zh"
        ? savedLocale
        : navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
      setLocale(initialLocale);
      document.documentElement.lang = initialLocale === "zh" ? "zh-CN" : "en";
      const saved = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) || "[]");
      if (Array.isArray(saved)) setActivities(mergeActivityHistory(saved));
      const savedAggregator = localStorage.getItem(FEE_AGGREGATOR_STORAGE_KEY);
      if (!FEE_AGGREGATOR && savedAggregator) {
        setFeeAggregator(getAddress(savedAggregator));
      }
    } catch {
      // A restricted browser may block localStorage; current-session history still works.
    }
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(activities.slice(0, 100)));
    } catch {
      // Keep in-memory history when persistent storage is unavailable.
    }
  }, [activities, storageReady]);

  function changeLocale(next: Locale) {
    setLocale(next);
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch {}
  }

  function navigate(next: "bridge" | "activity") {
    setView(next);
    window.history.pushState(null, "", next === "activity" ? "#activity" : "#bridge");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateActivity(id: string, patch: Partial<ActivityRecord>) {
    setActivities((current) => current.map((item) =>
      item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
    ));
  }

  function continueActivity(item: ActivityRecord) {
    if (!address || item.wallet.toLowerCase() !== address.toLowerCase()) {
      setError(locale === "zh" ? "请先连接该历史记录对应的钱包。" : "Connect the wallet used for this transfer first.");
      navigate("bridge");
      return;
    }
    setAmount(item.amount);
    setDepositHash(item.depositHash);
    setFeeHash(item.feeHash);
    setResumeActivityId(item.id);
    setStage("ready");
    setStatusKey("gatewayReady");
    setStatusAmount(item.amount);
    setError("");
    navigate("bridge");
  }

  async function deployAggregator() {
    if (!address || !walletClient || !window.ethereum) return connect();
    setDeployingAggregator(true);
    setError("");
    try {
      await switchChain(base.id);
      const bytecodeText = await (await fetch("/base-gateway-fee-aggregator.bin")).text();
      const bytecode = `0x${bytecodeText.trim()}` as Hex;
      const data = encodeDeployData({
        abi: feeAggregatorDeploymentAbi,
        bytecode,
        args: [BASE_USDC, GATEWAY_WALLET, getAddress("0xF045EF7CF9A7774199167BdbFf2A7F4f63B29D52")],
      });
      const hash = await walletClient.sendTransaction({ account: address, data });
      const receiptClient = createPublicClient({
        chain: base,
        transport: custom(window.ethereum),
      });
      const receipt = await receiptClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error("Deployment receipt did not include a contract address.");
      const deployedAddress = getAddress(receipt.contractAddress);
      setFeeAggregator(deployedAddress);
      localStorage.setItem(FEE_AGGREGATOR_STORAGE_KEY, deployedAddress);
      setStatusKey("newReady");
    } catch (cause) {
      setError(friendlyError(cause, locale));
    } finally {
      setDeployingAggregator(false);
    }
  }

  const value = useMemo(() => {
    try {
      return amount ? parseUnits(amount, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);
  const gatewayDebit = value > 0n ? value + CIRCLE_FEE_RESERVE : 0n;
  const needsGatewayFunding = value > 0n && gatewayBalance < gatewayDebit;
  const serviceFeeBase = needsGatewayFunding ? gatewayDebit : value;
  const serviceFee = serviceFeeBase > 0n
    ? (serviceFeeBase * SERVICE_FEE_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR
    : 0n;
  const totalDebit = serviceFeeBase + serviceFee;
  const maxGatewayAmount =
    gatewayBalance > CIRCLE_FEE_RESERVE ? gatewayBalance - CIRCLE_FEE_RESERVE : 0n;
  const maxBaseDeposit = (() => {
    if (baseBalance <= CIRCLE_FEE_RESERVE) return 0n;
    let deposit = (baseBalance * BPS_DENOMINATOR) /
      (BPS_DENOMINATOR + SERVICE_FEE_BPS);
    const depositFee =
      (deposit * SERVICE_FEE_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
    if (deposit + depositFee > baseBalance) deposit -= 1n;
    return deposit > CIRCLE_FEE_RESERVE ? deposit - CIRCLE_FEE_RESERVE : 0n;
  })();

  const walletClient = useMemo(() => {
    if (typeof window === "undefined" || !window.ethereum) return null;
    return createWalletClient({ chain: base, transport: custom(window.ethereum) });
  }, []);

  const refresh = useCallback(async (wallet = address) => {
    if (!wallet) return;
    const readClient = typeof window !== "undefined" && window.ethereum
      ? createPublicClient({ chain: base, transport: custom(window.ethereum) })
      : baseClient;
    const [balanceResult, allowanceResult, balancesResult, depositsResult] =
      await Promise.allSettled([
      readClient.readContract({
        address: BASE_USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      }),
      readClient.readContract({
        address: BASE_USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet, feeAggregator ?? GATEWAY_WALLET],
      }),
      gatewayPost("balances", {
        token: "USDC",
        sources: [{ depositor: wallet }],
      }),
      gatewayPost("deposits", {
        token: "USDC",
        sources: [{ depositor: wallet }],
      }),
    ]);

    if (balanceResult.status === "fulfilled") setBaseBalance(balanceResult.value);
    if (allowanceResult.status === "fulfilled") setAllowance(allowanceResult.value);
    const balances = balancesResult.status === "fulfilled"
      ? balancesResult.value
      : { balances: [] };
    const deposits = depositsResult.status === "fulfilled"
      ? depositsResult.value
      : { deposits: [] };
    const entries: GatewayBalance[] = balances?.balances || balances?.tokenBalances || [];
    const baseEntry = entries.find((item) => Number(item.domain) === BASE_DOMAIN);
    const finalizedGatewayBalance = normalizeGatewayAmount(baseEntry?.balance);
    setGatewayBalance(finalizedGatewayBalance);

    const pending: GatewayDeposit[] = deposits?.deposits || [];
    const basePending = pending.find(
      (item) => Number(item.domain) === BASE_DOMAIN && item.status === "pending",
    );
    if (basePending) {
      setStatusKey("pendingDeposit");
      setStatusAmount(
        basePending.amount
          ? formatUnits(normalizeGatewayAmount(basePending.amount), 6)
          : "",
      );
    } else if (finalizedGatewayBalance > 0n && ["connect", "ready", "error", "success"].includes(stage)) {
      setStatusKey("gatewayReady");
      setStatusAmount(formatUnits(finalizedGatewayBalance, 6));
    }
  }, [address, stage, feeAggregator]);

  useEffect(() => {
    if (!address) return;
    const initial = setTimeout(() => refresh(address).catch(() => undefined), 0);
    const timer = setInterval(() => refresh(address).catch(() => undefined), 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [address, refresh]);

  useEffect(() => {
    if (!address || !window.ethereum) return;
    let cancelled = false;
    const reconcileBaseDeposits = async () => {
      const tracked = activities.filter(
        (item) =>
          item.wallet.toLowerCase() === address.toLowerCase() &&
          item.depositHash &&
          ["depositing", "finalizing", "interrupted"].includes(item.stage),
      );
      if (!tracked.length) return;
      const results = await Promise.all(tracked.map(async (item) => {
        try {
          const receipt = await baseClient.getTransactionReceipt({ hash: item.depositHash! });
          return { id: item.id, status: receipt.status === "success" ? "success" : "failed" } as const;
        } catch {
          return { id: item.id, status: "pending" } as const;
        }
      }));
      if (cancelled) return;
      setActivities((current) => {
        let changed = false;
        const next = current.map((item) => {
          const result = results.find((entry) => entry.id === item.id);
          if (!result || item.baseDepositStatus === result.status) return item;
          changed = true;
          return {
            ...item,
            baseDepositStatus: result.status,
            baseConfirmedAt:
              result.status === "success" ? item.baseConfirmedAt ?? Date.now() : item.baseConfirmedAt,
            stage: result.status === "failed" ? "error" as const : item.stage,
            error: result.status === "failed" ? copy[locale].baseFailed : item.error,
            updatedAt: Date.now(),
          };
        });
        return changed ? next : current;
      });
    };
    void reconcileBaseDeposits();
    const timer = setInterval(reconcileBaseDeposits, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [address, activities, locale]);

  useEffect(() => {
    if (!address || gatewayBalance <= 0n) return;
    setActivities((current) => {
      let changed = false;
      const next = current.map((item) => {
        if (
          item.wallet.toLowerCase() !== address.toLowerCase() ||
          !["finalizing", "error"].includes(item.stage) ||
          item.baseDepositStatus !== "success"
        ) return item;
        let recordValue = 0n;
        try { recordValue = parseUnits(item.amount, 6); } catch { return item; }
        const requiredGatewayBalance = recordValue + CIRCLE_FEE_RESERVE;
        if (gatewayBalance < requiredGatewayBalance) {
          const isRecoverableFeeError =
            ["error", "interrupted"].includes(item.stage) &&
            item.error?.toLowerCase().includes("insufficient balance") &&
            gatewayBalance > CIRCLE_FEE_RESERVE;
          if (!isRecoverableFeeError) return item;
          changed = true;
          return {
            ...item,
            amount: formatUnits(gatewayBalance - CIRCLE_FEE_RESERVE, 6),
            stage: "interrupted" as const,
            error: undefined,
            updatedAt: Date.now(),
          };
        }
        changed = true;
        return {
          ...item,
          stage: "ready_to_continue" as const,
          error: undefined,
          updatedAt: Date.now(),
        };
      });
      return changed ? next : current;
    });
  }, [address, gatewayBalance, activities]);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;
    const handleAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (!accounts?.[0]) {
        setAddress(undefined);
        setStage("connect");
        return;
      }
      setAddress(getAddress(accounts[0]));
    };
    provider.on("accountsChanged", handleAccounts);
    return () => provider.removeListener?.("accountsChanged", handleAccounts);
  }, []);

  async function connect() {
    if (!window.ethereum) {
      setError(t.noWallet);
      return;
    }
    setError("");
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];
    const wallet = getAddress(accounts[0]);
    setAddress(wallet);
    setStage("ready");
    setStatusKey("connected");
    await refresh(wallet);
  }

  function disconnect() {
    setWalletMenuOpen(false);
    setAddress(undefined);
    setAmount("");
    setBaseBalance(0n);
    setGatewayBalance(0n);
    setAllowance(0n);
    setStage("connect");
    setStatusKey("ready");
    setStatusAmount("");
    setError("");
    setDepositHash(undefined);
    setFeeHash(undefined);
    setMintHash(undefined);
    setTransferId("");
    setFee("—");
    setBusy(false);
  }

  async function switchChain(chainId: number) {
    if (!window.ethereum) throw new Error("Wallet unavailable");
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!message.includes("4902") && !message.toLowerCase().includes("unrecognized")) {
        throw cause;
      }
      if (chainId !== ARC_CHAIN_ID) throw cause;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
            chainName: "Arc Mainnet",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: ["https://rpc.blockdaemon.mainnet.arc.io"],
            blockExplorerUrls: ["https://explorer.arc.io"],
          },
        ],
      });
    }
  }

  async function writeOnBase(to: Address, data: Hex, onSubmitted?: (hash: Hex) => void) {
    if (!address || !walletClient) throw new Error("Connect wallet first");
    await switchChain(base.id);
    const hash = await walletClient.sendTransaction({ account: address, to, data });
    onSubmitted?.(hash);
    const receiptClient = createPublicClient({
      chain: base,
      transport: custom(window.ethereum!),
    });
    const receipt = await receiptClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Base transaction reverted.");
    return hash;
  }

  async function mintOnArc(
    activityId: string,
    transferAmount: string,
    attestationPayload: Hex,
    attestationSignature: Hex,
  ) {
    if (!address || !window.ethereum) throw new Error("Connect wallet first");
    setStage("minting");
    setStatusKey("mintingStatus");
    updateActivity(activityId, {
      stage: "minting",
      attestationPayload,
      attestationSignature,
      error: undefined,
    });
    await switchChain(ARC_CHAIN_ID);
    const arcWallet = createWalletClient({
      account: address,
      chain: arc,
      transport: custom(window.ethereum!),
    });
    const hash = await arcWallet.sendTransaction({
      account: address,
      to: GATEWAY_MINTER,
      data: encodeFunctionData({
        abi: gatewayMinterAbi,
        functionName: "gatewayMint",
        args: [attestationPayload, attestationSignature],
      }),
    });
    setMintHash(hash);
    updateActivity(activityId, { stage: "minting", mintHash: hash });
    const receipt = await arcClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Arc claim transaction reverted.");
    setStage("success");
    setResumeActivityId("");
    setStatusKey("successStatus");
    setStatusAmount(transferAmount);
    updateActivity(activityId, { stage: "success", mintHash: hash, error: undefined });
  }

  async function bridge() {
    if (!address || !walletClient) return connect();
    const resumedActivity = resumeActivityId
      ? activities.find(
          (item) =>
            item.id === resumeActivityId &&
            item.wallet.toLowerCase() === address.toLowerCase() &&
            item.amount === amount &&
            ["ready_to_continue", "interrupted"].includes(item.stage),
        )
      : undefined;

    // Once Circle has issued a transfer, its Gateway balance is already debited.
    // Resume from the saved/fetched attestation instead of creating another transfer.
    if (resumedActivity?.transferId) {
      setBusy(true);
      setError("");
      setTransferId(resumedActivity.transferId);
      setDepositHash(resumedActivity.depositHash);
      setFeeHash(resumedActivity.feeHash);
      try {
        let payload = resumedActivity.attestationPayload;
        let signature = resumedActivity.attestationSignature;
        if (!payload || !signature) {
          setStage("attesting");
          setStatusKey("attestingStatus");
          const recovered = await gatewayPost("transfer-status", {
            id: resumedActivity.transferId,
          });
          payload = (
            recovered?.attestation?.payload ??
            (typeof recovered?.attestation === "string" ? recovered.attestation : undefined)
          ) as Hex | undefined;
          signature = (
            recovered?.attestation?.signature ?? recovered?.signature
          ) as Hex | undefined;
          if (!payload || !signature) {
            throw new Error(
              locale === "zh"
                ? "Circle 尚未返回可领取的证明，请稍后再次点击继续。"
                : "Circle has not returned a claimable attestation yet. Try again shortly.",
            );
          }
          updateActivity(resumedActivity.id, {
            stage: "minting",
            attestationPayload: payload,
            attestationSignature: signature,
            error: undefined,
          });
        }
        await mintOnArc(resumedActivity.id, resumedActivity.amount, payload, signature);
      } catch (cause) {
        const message = friendlyError(cause, locale);
        setStage("error");
        setError(message);
        setStatusKey("safeError");
        updateActivity(resumedActivity.id, { stage: "interrupted", error: message });
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!feeAggregator) {
      setError(t.aggregatorMissing);
      return;
    }
    if (value <= 0n) {
      setError(t.invalidAmount);
      return;
    }
    const isResuming = Boolean(
      resumedActivity &&
      (
        resumedActivity.baseDepositStatus === "success" ||
        resumedActivity.depositHash ||
        resumedActivity.feeHash
      ),
    );
    const needsDeposit = !isResuming && gatewayBalance < gatewayDebit;
    const baseNeeded = isResuming ? 0n : needsDeposit ? totalDebit : serviceFee;
    if (baseBalance < baseNeeded) {
      setError(t.insufficient);
      return;
    }

    setBusy(true);
    setError("");
    setDepositHash(resumedActivity?.depositHash);
    setFeeHash(resumedActivity?.feeHash);
    setMintHash(undefined);
    setTransferId("");
    const activityId = resumedActivity?.id ?? crypto.randomUUID();
    const startedAt = Date.now();
    if (!resumedActivity) {
      const newActivity: ActivityRecord = {
        id: activityId,
        wallet: address,
        amount,
        stage: "ready",
        serviceFee: formatUnits(serviceFee, 6),
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      setActivities((current) => [newActivity, ...current].slice(0, 100));
    }

    try {
      let available = gatewayBalance;
      const requiredAllowance = isResuming ? 0n : needsDeposit ? totalDebit : serviceFee;

      if (!isResuming && allowance < requiredAllowance) {
        setStage("approving");
        setStatusKey("approveStatus");
        updateActivity(activityId, { stage: "approving" });
        await writeOnBase(
          BASE_USDC,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [feeAggregator, requiredAllowance],
          }),
        );
        setAllowance(requiredAllowance);
      }

      if (isResuming) {
        updateActivity(activityId, { stage: "estimating" });
      } else if (needsDeposit) {
        setStage("depositing");
        setStatusKey("depositStatus");
        updateActivity(activityId, { stage: "depositing" });
        const hash = await writeOnBase(
          feeAggregator,
          encodeFunctionData({
            abi: feeAggregatorAbi,
            functionName: "depositWithFee",
            args: [gatewayDebit],
          }),
          (submittedHash) => {
            setDepositHash(submittedHash);
            setFeeHash(submittedHash);
            updateActivity(activityId, {
              stage: "depositing",
              depositHash: submittedHash,
              feeHash: submittedHash,
              baseDepositStatus: "pending",
            });
          },
        );
        setDepositHash(hash);
        setFeeHash(hash);
        updateActivity(activityId, {
          stage: "finalizing",
          depositHash: hash,
          feeHash: hash,
          baseDepositStatus: "success",
          baseConfirmedAt: Date.now(),
        });
        setStage("finalizing");
        setStatusKey("finalizingStatus");

        for (;;) {
          const result = await gatewayPost("balances", {
            token: "USDC",
            sources: [{ depositor: address }],
          });
          const entries: GatewayBalance[] =
            result?.balances || result?.tokenBalances || [];
          const baseEntry = entries.find((item) => Number(item.domain) === BASE_DOMAIN);
          available = normalizeGatewayAmount(baseEntry?.balance);
          setGatewayBalance(available);
          if (available >= gatewayDebit) break;
          await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
      } else {
        setStage("charging");
        setStatusKey("feeStatus");
        setStatusAmount(formatUnits(serviceFee, 6));
        updateActivity(activityId, { stage: "charging" });
        const serviceFeeHash = await writeOnBase(
          feeAggregator,
          encodeFunctionData({
            abi: feeAggregatorAbi,
            functionName: "payFee",
            args: [value],
          }),
          (submittedHash) => {
            setFeeHash(submittedHash);
            updateActivity(activityId, { stage: "charging", feeHash: submittedHash });
          },
        );
        setFeeHash(serviceFeeHash);
        updateActivity(activityId, { stage: "estimating", feeHash: serviceFeeHash });
      }

      setStage("estimating");
      setStatusKey("estimatingStatus");
      updateActivity(activityId, { stage: "estimating" });
      const draft = buildDraft(address, value);
      const estimate = await gatewayPost("estimate", [
        {
          spec: draft.spec,
          maxBlockHeight: draft.maxBlockHeight,
          maxFee: draft.maxFee,
        },
      ]);
      const burnIntentRaw = estimate?.body?.[0]?.burnIntent || draft;
      const maxFee = BigInt(burnIntentRaw.maxFee ?? draft.maxFee);
      const burnIntent: BurnIntentMessage = {
        maxBlockHeight: BigInt(burnIntentRaw.maxBlockHeight ?? draft.maxBlockHeight),
        maxFee,
        spec: {
          ...draft.spec,
          ...burnIntentRaw.spec,
          version: Number(burnIntentRaw.spec?.version ?? 1),
          sourceDomain: Number(burnIntentRaw.spec?.sourceDomain ?? BASE_DOMAIN),
          destinationDomain: Number(burnIntentRaw.spec?.destinationDomain ?? ARC_DOMAIN),
          value: BigInt(burnIntentRaw.spec?.value ?? value),
          sourceContract: ensureBytes32(
            (burnIntentRaw.spec?.sourceContract ?? draft.spec.sourceContract) as Hex,
          ),
          destinationContract: ensureBytes32(
            (burnIntentRaw.spec?.destinationContract ?? draft.spec.destinationContract) as Hex,
          ),
          sourceToken: ensureBytes32(
            (burnIntentRaw.spec?.sourceToken ?? draft.spec.sourceToken) as Hex,
          ),
          destinationToken: ensureBytes32(
            (burnIntentRaw.spec?.destinationToken ?? draft.spec.destinationToken) as Hex,
          ),
          sourceDepositor: ensureBytes32(
            (burnIntentRaw.spec?.sourceDepositor ?? draft.spec.sourceDepositor) as Hex,
          ),
          destinationRecipient: ensureBytes32(
            (burnIntentRaw.spec?.destinationRecipient ?? draft.spec.destinationRecipient) as Hex,
          ),
          sourceSigner: ensureBytes32(
            (burnIntentRaw.spec?.sourceSigner ?? draft.spec.sourceSigner) as Hex,
          ),
          destinationCaller: ensureBytes32(
            (burnIntentRaw.spec?.destinationCaller ?? draft.spec.destinationCaller) as Hex,
          ),
        },
      };
      setFee(estimate?.fees?.total ? `${estimate.fees.total} USDC` : formatUnits(maxFee, 6));

      setStage("signing");
      setStatusKey("signingStatus");
      updateActivity(activityId, { stage: "signing" });
      const signature = await walletClient.signTypedData({
        account: address,
        domain: { name: "GatewayWallet", version: "1" },
        types: { EIP712Domain, TransferSpec, BurnIntent },
        primaryType: "BurnIntent",
        message: burnIntent,
      });

      setStage("attesting");
      setStatusKey("attestingStatus");
      updateActivity(activityId, { stage: "attesting" });
      const transfer = await gatewayPost("transfer", [
        { burnIntent, signature },
      ]);
      setTransferId(transfer.transferId || "");
      updateActivity(activityId, {
        stage: "minting",
        transferId: transfer.transferId || "",
        attestationPayload: transfer.attestation as Hex,
        attestationSignature: transfer.signature as Hex,
      });
      await mintOnArc(
        activityId,
        amount,
        transfer.attestation as Hex,
        transfer.signature as Hex,
      );
    } catch (cause) {
      const message = friendlyError(cause, locale);
      setStage("error");
      setError(message);
      setStatusKey("safeError");
      setActivities((current) => {
        const target = current.find((item) => item.id === activityId);
        const hasIdentity = Boolean(
          target?.depositHash || target?.feeHash || target?.transferId || target?.mintHash,
        );
        if (!hasIdentity) return current.filter((item) => item.id !== activityId);
        return current.map((item) => {
          if (item.id !== activityId) return item;
        const resumable =
          item.baseDepositStatus === "success" ||
          Boolean(item.feeHash || item.depositHash || item.transferId);
        return {
          ...item,
          stage: resumable ? "interrupted" : "error",
          error: message,
          updatedAt: Date.now(),
        };
        });
      });
    } finally {
      setBusy(false);
    }
  }

  const buttonText = !address
    ? t.connect
    : stage === "approving"
      ? t.approving
      : stage === "depositing"
        ? t.depositing
      : stage === "finalizing"
          ? t.waiting
          : stage === "charging"
            ? locale === "zh" ? "正在收取服务费…" : "Collecting service fee…"
          : stage === "estimating"
            ? t.estimating
            : stage === "signing"
              ? t.signing
              : stage === "attesting"
                ? t.attesting
                : stage === "minting"
                  ? t.minting
                  : stage === "success"
                    ? t.another
                    : allowance < (gatewayBalance < gatewayDebit ? totalDebit : serviceFee)
                      ? t.approveBridge
                      : t.bridgeUsdc;

  const activeStep =
    ["connect", "ready", "approving", "depositing", "finalizing", "charging"].includes(stage)
      ? 1
      : ["ready_to_continue", "interrupted", "estimating", "signing", "attesting"].includes(stage)
        ? 2
        : 3;

  return (
    <main className="app-shell">
      <div className="orbit orbit-one" aria-hidden="true" />
      <div className="orbit orbit-two" aria-hidden="true" />
      <header className="app-header">
        <nav aria-label={locale === "zh" ? "主导航" : "Main navigation"}>
          <button className={view === "bridge" ? "active" : ""} onClick={() => navigate("bridge")}>{t.bridge}</button>
          <button className={view === "activity" ? "active" : ""} onClick={() => navigate("activity")}>{t.activity}</button>
        </nav>
        <div className="header-actions">
          <div className="language-switch" aria-label="Language">
            <button className={locale === "zh" ? "selected" : ""} onClick={() => changeLocale("zh")}>中</button>
            <button className={locale === "en" ? "selected" : ""} onClick={() => changeLocale("en")}>EN</button>
          </div>
          <button
            className="wallet-button"
            onClick={address ? () => setWalletMenuOpen((open) => !open) : connect}
            title={address ? t.connectedWallet : t.connect}
            aria-expanded={address ? walletMenuOpen : undefined}
          >
            <span className="wallet-icon">▣</span>
            {address ? shortAddress(address) : t.connect}
          </button>
          {address && walletMenuOpen && (
            <>
              <button
                className="wallet-menu-backdrop"
                aria-label="Close wallet menu"
                onClick={() => setWalletMenuOpen(false)}
              />
              <div className="wallet-menu" role="dialog" aria-label={t.connectedWallet}>
                <small>{t.connectedWallet}</small>
                <strong>{shortAddress(address)}</strong>
                <button className="disconnect-button" onClick={disconnect}>
                  {t.disconnect}
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {view === "bridge" && <section id="bridge" className="hero">
        <div className="eyebrow"><span /> {t.eyebrow} <span /></div>
        <div className="bridge-card">
          <div className="network-row">
            <div className="network-chip">
              <img className="chain-logo base-logo" src="/base-logo.png" alt="Base" />
              <div><strong>Base</strong></div>
            </div>
            <span className="route-arrow">→</span>
            <div className="network-chip arc-chip">
              <img className="chain-logo arc-logo" src="/arc-logo.png" alt="Arc" />
              <div><strong>Arc</strong></div>
            </div>
          </div>

          <label className="amount-panel">
            <span className="amount-label">{t.youSend}</span>
            <div className="amount-row">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.00"
                aria-label={t.amountLabel}
              />
              <span className="token-pill"><i>$</i> USDC</span>
            </div>
            <div className="balance-row">
              <span>{t.baseBalance} {formatUnits(baseBalance, 6)} USDC</span>
              <button
                type="button"
                onClick={() => setAmount(formatUnits(
                  maxGatewayAmount > 0n ? maxGatewayAmount : maxBaseDeposit,
                  6,
                ))}
                disabled={!address}
              >
                MAX
              </button>
            </div>
          </label>

          {address && gatewayBalance > 0n && !busy && (
            <div className="gateway-ready" role="status">
              <span className="gateway-ready-icon">✓</span>
              <div>
                <strong>{t.gatewayPromptTitle}</strong>
                <p>{t.gatewayPromptBody}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAmount(formatUnits(maxGatewayAmount, 6));
                  setError("");
                  setStatusKey("gatewayReady");
                  setStatusAmount(formatUnits(gatewayBalance, 6));
                }}
              >
                {t.useGatewayBalance}
              </button>
            </div>
          )}

          <div className="route-summary">
            <div><span>{t.route}</span><strong>Base <b>→</b> Circle Gateway <b>→</b> Arc</strong></div>
            <div><span>{t.available}</span><strong>{formatUnits(gatewayBalance, 6)} USDC</strong></div>
            <div><span>{t.circleReserve}</span><strong>0.01 USDC</strong></div>
            <div><span>{t.serviceFee}</span><strong>{formatUnits(serviceFee, 6)} USDC</strong></div>
            <div><span>{t.fee}</span><strong>{fee}</strong></div>
          </div>

          {error && <div className="error-box" role="alert">{error}</div>}

          {!feeAggregator && address ? (
            <button className="primary-button deploy-button" onClick={deployAggregator} disabled={deployingAggregator}>
              <span className="wallet-icon">◇</span>
              {deployingAggregator ? t.deployingAggregator : t.deployAggregator}
            </button>
          ) : <button className="primary-button" onClick={stage === "success" ? () => {
            setStage("ready");
            setAmount("");
            setFee("—");
            setFeeHash(undefined);
            setStatusKey("newReady");
          } : bridge} disabled={busy}>
            <span className="wallet-icon">▣</span>{buttonText}
          </button>}

          <div className="stepper" aria-label={locale === "zh" ? "跨链进度" : "Bridge progress"}>
            {[
              ["1", t.deposit],
              ["2", t.sign],
              ["3", t.mint],
            ].map(([number, label], index) => (
              <div key={number} className={activeStep > index + 1 ? "done" : activeStep === index + 1 ? "current" : ""}>
                <span>{activeStep > index + 1 ? "✓" : number}</span>
                <small>{label}</small>
              </div>
            ))}
          </div>

          <div className="live-status" aria-live="polite">
            <span className={busy ? "status-dot pulse" : "status-dot"} />
            <div>
              <strong>{stage === "success" ? t.complete : t.transferStatus}</strong>
              <p>{status}</p>
              <div className="links">
                {depositHash && <a href={`https://basescan.org/tx/${depositHash}`} target="_blank" rel="noreferrer">{t.baseDeposit}</a>}
                {feeHash && feeHash !== depositHash && <a href={`https://basescan.org/tx/${feeHash}`} target="_blank" rel="noreferrer">{t.feeTransaction}</a>}
                {mintHash && <a href={`https://explorer.arc.io/tx/${mintHash}`} target="_blank" rel="noreferrer">{t.arcMint}</a>}
                {transferId && <span>{t.gatewayId} {shortAddress(transferId)}</span>}
              </div>
            </div>
          </div>

          <footer className="powered">
            <span className="gateway-mark">◉</span>
            {t.powered}{" "}
            <a href="https://x.com/kkmoat" target="_blank" rel="noreferrer">
              @kkmoat
            </a>
          </footer>
        </div>
      </section>}

      {view === "activity" && <section id="activity" className="activity-section activity-page">
        <div className="activity-heading">
          <div><h2>{t.activityTitle}</h2><p>{t.activitySubtitle}</p></div>
          <span className="history-count">{activities.length}</span>
        </div>
        {activities.length === 0 ? (
          <div className="activity-empty">◎<span>{t.empty}</span></div>
        ) : (
          <div className="activity-list">
            {activities.map((item) => (
              <article className="activity-item" key={item.id}>
                <div className="activity-main">
                  <span className={`activity-state state-${item.stage}`} />
                  <div>
                    <strong>{item.amount} USDC</strong>
                    <span>Base → Arc · {shortAddress(item.wallet)}</span>
                  </div>
                </div>
                <div className="activity-meta">
                  <span>{t.statusLabel}<strong>{stageLabels[locale][item.stage]}</strong></span>
                  <span>{t.started}<strong>{new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(item.createdAt)}</strong></span>
                </div>
                {item.depositHash && (
                  <div className={`deposit-result deposit-${item.baseDepositStatus || "pending"}`}>
                    <span />
                    {item.baseDepositStatus === "success"
                      ? t.baseSucceeded
                      : item.baseDepositStatus === "failed"
                        ? t.baseFailed
                        : t.baseConfirming}
                    {item.stage === "finalizing" && ` · ${t.circleWaiting}`}
                  </div>
                )}
                {["finalizing", "ready_to_continue"].includes(item.stage) && item.baseDepositStatus === "success" && (() => {
                  const confirmedAt = item.baseConfirmedAt ?? item.updatedAt;
                  const estimatedPercent = item.stage === "ready_to_continue"
                    ? 100
                    : Math.min(
                        95,
                        Math.max(1, Math.floor(((clock - confirmedAt) / (20 * 60_000)) * 100)),
                      );
                  return (
                    <div className="circle-progress">
                      <div>
                        <span>{t.estimatedProgress}</span>
                        <strong>{estimatedPercent}%</strong>
                      </div>
                      <div className="progress-track">
                        <span style={{ width: `${estimatedPercent}%` }} />
                      </div>
                    </div>
                  );
                })()}
                {(item.depositHash || item.feeHash || item.mintHash || item.transferId) && (
                  <div className="activity-links links">
                    {item.depositHash && <a href={`https://basescan.org/tx/${item.depositHash}`} target="_blank" rel="noreferrer">{t.baseDeposit}</a>}
                    {item.feeHash && item.feeHash !== item.depositHash && <a href={`https://basescan.org/tx/${item.feeHash}`} target="_blank" rel="noreferrer">{t.feeTransaction}</a>}
                    {item.mintHash && <a href={`https://explorer.arc.io/tx/${item.mintHash}`} target="_blank" rel="noreferrer">{t.arcMint}</a>}
                    {item.transferId && <span>{t.gatewayId} {shortAddress(item.transferId)}</span>}
                  </div>
                )}
                {item.error && <p className="activity-error">{friendlyError(item.error, locale)}</p>}
                {["ready_to_continue", "interrupted"].includes(item.stage) && (
                  <button className="continue-button" onClick={() => continueActivity(item)}>
                    {t.continueTransfer} →
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
        <p className="local-note">◈ {t.localNote}</p>
      </section>}

      {view === "bridge" && <section className="safety-note">
        <strong>{t.before}</strong>
        <p>{t.safety}</p>
      </section>}

      <a
        className="docs-corner"
        href="https://developers.circle.com/gateway"
        target="_blank"
        rel="noreferrer"
      >
        {t.docs} ↗
      </a>
    </main>
  );
}
