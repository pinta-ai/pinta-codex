import type { OtlpPayload } from "@pinta-ai/core";
import type { PintaCodexConfig } from "../core/config.js";
import type { GuardResult } from "../core/guard.js";
import { evaluateGuard } from "../core/guard.js";

/**
 * The part of a gate that must NOT differ between the two gates.
 *
 * Codex asks about the same tool call on two events: `PreToolUse` from the
 * dispatch path, and `PermissionRequest` from the approval path. They carry the
 * same `tool_name` + `tool_input` shape and differ only in what they may reply.
 * If each handler assembled its own guard request, the two could drift, and the
 * failure mode is not a crash — it is one action getting two verdicts depending
 * on which gate happened to ask. guard-runtime has already paid for that shape
 * once (PTA-318, where a Copilot CLI write classified as `other` on
 * `PermissionRequest` and as `file-io` on `PreToolUse`, so the file body was
 * scanned as a command line on one path and not the other).
 *
 * Since core 0.8.0 there is nothing left to assemble: the guard is asked about
 * the span the gate is about to relay (`buildEventPayload`), the one reading of
 * the event that exists. The host's own event name rides on it as `codex.hook`
 * — guard-runtime keys tool classification on the event, and `PermissionRequest`
 * is in its `HOOK_EVENTS` set precisely because it is a tool-bearing gate.
 */
export async function evaluateToolGate(
  payload: OtlpPayload,
  config: PintaCodexConfig,
): Promise<GuardResult | null> {
  // codex CLI doesn't inject pinta-codex.env into hook env; config.guardEndpoint
  // already merges process.env + envFile fallback (1.2.4).
  return evaluateGuard(payload, config.guardEndpoint);
}

/**
 * The reason string attached to a refusal, guaranteed non-empty.
 *
 * Both gates discard a refusal that cannot say why:
 *
 *   PreToolUse        "…returned permissionDecision:deny without a non-empty
 *                      permissionDecisionReason"
 *   PermissionRequest `message` is optional in the schema, but a denial with
 *                      nothing to show the user is indistinguishable from a
 *                      malfunction.
 *
 * A guard DENY with a null reason is not hypothetical — `GuardResult.reason` is
 * `string | null` — so the fallback is what stands between a real block and a
 * silently dropped one.
 */
export function denyReason(guard: GuardResult | null | undefined): string {
  const reason = guard?.reason;
  if (typeof reason === "string" && reason.trim().length > 0) return reason;
  return "guard_deny";
}
