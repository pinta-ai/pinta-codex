import type { PintaCodexConfig } from "../core/config.js";
import type { PermissionRequestBlockOutput, PermissionRequestEvent } from "../core/types.js";
import { emitEvent } from "./emit.js";
import { denyReason, evaluateToolGate } from "./tool-gate.js";

/**
 * Codex's approval gate.
 *
 * Mirrors `handlePreToolUse` in everything except the output envelope, which is
 * a different shape — see `PermissionRequestBlockOutput`. The ordering
 * rationale is identical and equally load-bearing: the decision is written to
 * stdout BEFORE telemetry, because `runHook`'s outer catch is fail-open, so a
 * throw from `emitEvent` after a computed DENY would silently allow the call.
 */
export async function handlePermissionRequest(
  event: PermissionRequestEvent,
  config: PintaCodexConfig,
): Promise<number> {
  const guard = await evaluateToolGate(event, config);

  if (guard?.decision === "DENY") {
    const out: PermissionRequestBlockOutput = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: denyReason(guard),
        },
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  }

  try {
    await emitEvent(event, config, { trace: "current", guard });
  } catch (err) {
    process.stderr.write(`[pinta-codex] telemetry emit failed: ${err}\n`);
  }
  return 0;
}
