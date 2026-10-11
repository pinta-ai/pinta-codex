// codex-specific binding over the shared guard in @pinta-ai/core. Preserves the
// historical codex behavior: a short timeout (see TIMEOUT_MS), relay token +
// disable flag read from process.env, and a `pinta-codex/<version>` User-Agent.
//
// Since core 0.8.0 the guard is asked about the OTLP payload the gate is about
// to relay — the same object, built first — rather than a hand-assembled
// summary of the event. See `handlers/tool-gate.ts`.
import { evaluateGuard as coreEvaluateGuard } from "@pinta-ai/core";
import type { GuardPayload, GuardResult } from "@pinta-ai/core";
import { ADAPTER_VERSION } from "./version.js";

// Both types are core's verbatim. Until 1.12.0 `GuardResult` was a local copy
// that dropped the manager's `userMessage` on the way through — codex had
// never surfaced it, and a copy of a wire type is how one end quietly stops
// reading a field the other end still sends. That is exactly what happened:
// the three gates kept answering with the rule id (`deny_credentials`) while
// every sibling adaptor showed the policy's own message, and the output gate
// had nothing to show at all, so it shipped a fixed sentence.
//
// Since 1.12.0 (PTA-695) the result is passed through whole. `userMessage` is
// safe to put in front of the model: the manager never quotes credential or
// PII values in it, and for output inspections it quotes nothing from the
// output at all. The new optional fields — `evaluationId`, `outputAction`,
// `redactions` — feed core's `buildOutputDenial`, which turns a tool-output
// DENY into the masked or withheld text the model receives instead.
// `redactions[].match` carries the detected values themselves; it is read only
// there and never written to a span or a log (core's `attachGuard` does not
// emit it).
export type { GuardPayload, GuardResult };

// How long the gate waits for a verdict before it fail-opens (ALLOW). Short on
// purpose — every tool call blocks on it — but 50ms sat below the prod p99 of
// answers that did come back (58ms), so real verdicts were being discarded
// (PTA-579). core >=0.9.0 also declares this number to the manager as
// `x-pinta-guard-budget-ms`, which bounds its own work (the package check) by
// it; this is the only place to change it.
const TIMEOUT_MS = 100;

// Self-identify to the manager's guard route so it can attribute calls to this
// adaptor (the route parses `pinta-*/<version>` out of the User-Agent). Derived
// from ADAPTER_VERSION rather than written out: the same copy in two sibling
// adaptors shipped a stale number under a comment telling the reader to keep it
// in sync.
const GUARD_UA = `pinta-codex/${ADAPTER_VERSION}`;

export async function evaluateGuard(
  payload: GuardPayload,
  endpoint: string | undefined,
): Promise<GuardResult | null> {
  return coreEvaluateGuard(payload, endpoint, {
    timeoutMs: TIMEOUT_MS,
    token: process.env.PINTA_RELAY_TOKEN ?? '',
    disabled: process.env.PINTA_GUARD_DISABLED === '1',
    userAgent: GUARD_UA,
  });
}
