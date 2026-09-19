import { attachGuard } from "@pinta-ai/core";
import type { PintaCodexConfig } from "../core/config.js";
import type { HookBlockOutput, PreToolUseEvent } from "../core/types.js";
import { buildEventPayload, sendPayload } from "./emit.js";
import { denyReason, evaluateToolGate } from "./tool-gate.js";

/**
 * Codex's dispatch-path gate, and the primary one.
 *
 * Unlike `PermissionRequest` this fires regardless of approval policy, so it is
 * the only gate present under `--full-auto` and `approval_policy = "never"` —
 * the modes where nothing else would ask.
 */
export async function handlePreToolUse(
  event: PreToolUseEvent,
  config: PintaCodexConfig,
): Promise<number> {
  // The span is built BEFORE the guard is asked, and the guard is asked about
  // that span — one reading of the event, judged and stored alike.
  const payload = buildEventPayload(event, config, { trace: "current" });
  const guard = await evaluateToolGate(payload, config);

  // Emit the security decision to stdout BEFORE telemetry. Telemetry is
  // best-effort: a throw from sendPayload must never discard an already-computed
  // DENY (the outer runHook catch is fail-open, so a late throw would silently
  // ALLOW a denied tool).
  if (guard?.decision === "DENY") {
    const out: HookBlockOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyReason(guard),
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  }

  try {
    // codex's GuardResult intentionally omits the `userMessage` field that core
    // models. attachGuard never reads it, so widening here is behavior-safe.
    attachGuard(payload, guard as Parameters<typeof attachGuard>[1]);
    await sendPayload(payload, config);
  } catch (err) {
    process.stderr.write(`[pinta-codex] telemetry emit failed: ${err}\n`);
  }
  return 0;
}
