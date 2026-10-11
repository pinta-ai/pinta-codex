import { attachGuard, buildOutputDenial } from "@pinta-ai/core";
import type { PintaCodexConfig } from "../core/config.js";
import type { GuardResult } from "../core/guard.js";
import type { PostToolUseBlockOutput, PostToolUseEvent } from "../core/types.js";
import { buildEventPayload, deferPayload, sendPayload } from "./emit.js";
import { evaluateToolGate } from "./tool-gate.js";

/**
 * Codex's output gate.
 *
 * A `PostToolUse` hook that answers `{"decision":"block","reason"}` makes Codex
 * set `should_block` and push `reason` into the feedback the model reads in
 * place of the original result (codex-rs 0.154.0
 * `hooks/src/events/post_tool_use.rs`). That is the only replacement channel
 * this event has: `updatedMCPToolOutput` is explicitly unsupported (the hook
 * is ignored, fail-open) and `continue:false` ends the run, so neither is
 * emitted here. `reason` is where the whole substitute goes.
 *
 * Since 1.12.0 (PTA-695) the substitute is built by core's `buildOutputDenial`
 * from the manager's verdict: the policy's own `userMessage` plus the
 * evaluation id (`notice`), a fixed recovery hint (`guidance`), and — when the
 * manager said `outputAction:"mask"` and sent the detected values — the
 * original output with only those values replaced by `[REDACTED:<type>]`. An
 * older manager (< 0.1.16) sends neither field, which comes out as `withhold`:
 * notice and guidance, no output text. The original output never reaches
 * stdout unmasked, and the rule id (`reason`) never reaches it at all.
 */
export async function handlePostToolUse(
  event: PostToolUseEvent,
  config: PintaCodexConfig,
): Promise<number> {
  const payload = buildEventPayload(event, config, { trace: "current" });
  const guard = await evaluateToolGate(payload, config);
  // Written to stdout BEFORE telemetry, for the same reason as the other two
  // gates: `runHook`'s outer catch is fail-open, so a throw from the emit path
  // after a computed DENY would deliver the original output untouched.
  if (guard?.decision === "DENY") {
    const out: PostToolUseBlockOutput = { decision: "block", reason: outputDenialReason(event, guard) };
    process.stdout.write(JSON.stringify(out) + "\n");
  }

  try {
    attachGuard(payload, guard);
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

/**
 * The `reason` Codex substitutes for the tool result.
 *
 *   mask:     notice ⏎⏎ guidance ⏎⏎ masked output
 *   withhold: notice ⏎⏎ guidance
 *
 * The original is the same reading of `tool_response` the span carries as
 * `codex.tool_response`: the string itself, or the JSON of anything else.
 */
function outputDenialReason(event: PostToolUseEvent, guard: GuardResult): string {
  const original = typeof event.tool_response === "string"
    ? event.tool_response
    : JSON.stringify(event.tool_response) ?? "";
  const d = buildOutputDenial({ original, guard });
  return d.action === "mask"
    ? `${d.notice}\n\n${d.guidance}\n\n${d.text}`
    : `${d.notice}\n\n${d.guidance}`;
}
