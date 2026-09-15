import type { PintaCodexConfig } from "../core/config.js";
import type { HookBlockOutput, PreToolUseEvent } from "../core/types.js";
import { emitEvent } from "./emit.js";
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
  const guard = await evaluateToolGate(event, config);

  // Emit the security decision to stdout BEFORE telemetry. Telemetry is
  // best-effort: a throw from emitEvent must never discard an already-computed
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
    await emitEvent(event, config, { trace: "current", guard });
  } catch (err) {
    process.stderr.write(`[pinta-codex] telemetry emit failed: ${err}\n`);
  }
  return 0;
}
