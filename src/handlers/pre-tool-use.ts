import type { PintaCodexConfig } from "../core/config.js";
import type { HookBlockOutput, PreToolUseEvent } from "../core/types.js";
import { evaluateGuard } from "../core/guard.js";
import { emitEvent } from "./emit.js";

export async function handlePreToolUse(
  event: PreToolUseEvent,
  config: PintaCodexConfig,
): Promise<number> {
  // codex CLI doesn't inject pinta-codex.env into hook env; config.guardEndpoint
  // already merges process.env + envFile fallback (1.2.4).
  const rawToolInput = typeof event.tool_input === "string"
    ? event.tool_input
    : JSON.stringify(event.tool_input);
  const guard = await evaluateGuard(
    {
      spanId: event.session_id ?? "unknown",
      toolName: event.tool_name,
      toolInput: event.tool_input,
      rawTextFields: { toolInput: rawToolInput },
    },
    config.guardEndpoint,
  );

  await emitEvent(event, config, { trace: "current", guard });

  if (guard?.decision === "DENY") {
    const out: HookBlockOutput = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: guard.reason ?? "guard_deny",
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  }
  return 0;
}
