import { NextRequest, NextResponse } from "next/server";

const ALLOWED_ENDPOINTS = new Set([
  "balances",
  "deposits",
  "estimate",
  "transfer",
  "transfer-status",
]);
const GATEWAY_API = "https://gateway-api.circle.com/v1";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ endpoint: string }> },
) {
  const { endpoint } = await context.params;
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return NextResponse.json({ error: "Unsupported Gateway endpoint" }, { status: 404 });
  }

  try {
    const body = await request.text();
    let url = `${GATEWAY_API}/${endpoint}`;
    let method = "POST";
    let requestBody: string | undefined = body;
    if (endpoint === "transfer-status") {
      const id = String(JSON.parse(body || "{}")?.id || "");
      if (!/^[a-zA-Z0-9-]{8,128}$/.test(id)) {
        return NextResponse.json({ error: "Invalid Gateway transfer ID" }, { status: 400 });
      }
      url = `${GATEWAY_API}/transfer/${encodeURIComponent(id)}`;
      method = "GET";
      requestBody = undefined;
    }
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-ARC-PRIVATE-MAINNET-ENABLED": "true",
      },
      body: requestBody,
      cache: "no-store",
    });
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Gateway request failed",
      },
      { status: 502 },
    );
  }
}
