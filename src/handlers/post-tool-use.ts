import { attachGuard } from "@pinta-ai/core";
import type { PintaCodexConfig } from "../core/config.js";
import type { PostToolUseBlockOutput, PostToolUseEvent } from "../core/types.js";
import { buildEventPayload, deferPayload, sendPayload } from "./emit.js";
import { denyReason, evaluateToolGate } from "./tool-gate.js";

export async function handlePostToolUse(
  event: PostToolUseEvent,
  config: PintaCodexConfig,
): Promise<number> {
  const payload = buildEventPayload(event, config, { trace: "current" });
  const guard = await evaluateToolGate(payload, config);
  if (guard?.decision === "DENY") {
    const out: PostToolUseBlockOutput = { decision: "block", reason: denyReason(guard) };
    process.stdout.write(JSON.stringify(out) + "\n");
  }

  try {
    attachGuard(payload, guard as Parameters<typeof attachGuard>[1]);
    if (guard) payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.push({
      key: "pinta.guard.target", value: { stringValue: "tool_output" },
    });
    if (guard?.decision === "DENY") deferPayload(payload, config);
    else await sendPayload(payload, config);
  } catch (err) {
    process.stderr.write(`[pinta-codex] telemetry emit failed: ${err}\n`);
  }
  return 0;
}
