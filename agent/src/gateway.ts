// One chat completion through Bifrost. The agent loop, the freshness check
// and the answer checker all use this, so they read usage and routing
// headers the same way.
import type { Message } from "./context.js";

export const GATEWAY = process.env.BIFROST_URL ?? "http://localhost:8080";

export class GatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(`gateway ${status}: ${message}`);
  }
}

export async function gatewayChat(headers: Record<string, string>, payload: Record<string, unknown>, extra: Record<string, string> = {}) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(payload),
  });
  const body: any = await res.json();
  if (!res.ok) throw new GatewayError(res.status, body?.error?.message ?? JSON.stringify(body));
  const usage = body.usage ?? {};
  const provider = res.headers.get("x-bifrost-routing-info-provider") ?? res.headers.get("x-bifrost-provider");
  const servedModel = res.headers.get("x-bifrost-routing-info-model");
  const fallback = res.headers.get("x-bifrost-routing-info-is-fallback") === "true";
  const requestId = res.headers.get("x-bifrost-request-id");
  const cacheHit = res.headers.get("x-bifrost-cache-hit") === "true";
  return {
    message: body.choices[0].message as Message,
    usage,
    provider,
    servedModel,
    fallback,
    requestId,
    cacheHit,
    record: {
      model: `${provider}/${servedModel}`,
      prompt: usage.prompt_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      fallback,
      cacheHit,
      requestId,
    },
  };
}
