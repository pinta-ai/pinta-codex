// codex-specific binding over the shared guard in @pinta-ai/core. Preserves the
// historical codex behavior: a SHORT 50ms timeout, relay token + disable flag
// read from process.env, a `pinta-codex/<version>` User-Agent, and a result
// shape that does NOT carry the manager's `userMessage` field (codex has never
// surfaced it). We map core's richer result down to codex's historical shape.
import { evaluateGuard as coreEvaluateGuard } from "@pinta-ai/core";
import type { GuardInput } from "@pinta-ai/core";
import { ADAPTER_VERSION } from "./version.js";

// `GuardResult` below is down-projected on purpose — codex has never surfaced
// `userMessage`. `GuardInput` had no such reason: it was a verbatim copy of
// core's, and a copy of a wire type is how one end quietly stops sending a
// field the other end still reads. Re-exported so the two cannot disagree.
export type { GuardInput };

export interface GuardResult {
  decision: 'ALLOW' | 'DENY' | 'REVIEW';
  reason: string | null;
  durationMs: number;
  // Wall-clock RTT (ms) core measured for the guard call. Carried through the
  // down-projection below so core's buildPayload can emit pinta.client.rtt_ms;
  // dropping it would silently disable that attribute.
  clientRttMs?: number;
  failOpenReason?: 'timeout' | 'refused' | 'error';
}

const TIMEOUT_MS = 50;

// Self-identify to the manager's guard route so it can attribute calls to this
// adaptor (the route parses `pinta-*/<version>` out of the User-Agent). Derived
// from ADAPTER_VERSION rather than written out: the same copy in two sibling
// adaptors shipped a stale number under a comment telling the reader to keep it
// in sync.
const GUARD_UA = `pinta-codex/${ADAPTER_VERSION}`;

export async function evaluateGuard(
  input: GuardInput,
  endpoint: string | undefined,
): Promise<GuardResult | null> {
  const result = await coreEvaluateGuard(input, endpoint, {
    timeoutMs: TIMEOUT_MS,
    token: process.env.PINTA_RELAY_TOKEN ?? '',
    disabled: process.env.PINTA_GUARD_DISABLED === '1',
    userAgent: GUARD_UA,
  });
  if (result === null) return null;
  // Project down to codex's historical result shape (no `userMessage`).
  const out: GuardResult = {
    decision: result.decision,
    reason: result.reason,
    durationMs: result.durationMs,
    clientRttMs: result.clientRttMs,
  };
  if (result.failOpenReason !== undefined) out.failOpenReason = result.failOpenReason;
  return out;
}
