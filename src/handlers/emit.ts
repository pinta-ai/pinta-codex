import type { PintaCodexConfig } from "../core/config.js";
import type { BaseEvent } from "../core/types.js";
import type { GuardResult } from "../core/guard.js";
import { Transport } from "../core/transport.js";
import { TraceManager } from "../core/trace.js";
import { buildOtlpPayload } from "../core/otlp.js";

/**
 * Shared telemetry flow for the event handlers: flush any queued spans, resolve
 * the trace id, build the OTLP payload, and send it.
 *
 * `trace` selects how the trace id is resolved:
 *   - "current": reuse the active trace (PreToolUse, PostToolUse, Session, Stop)
 *   - "new":     rotate a fresh trace (UserPromptSubmit — one trace per turn)
 *
 * `guard` (optional) is folded into the span's pinta.guard.* attributes.
 */
export async function emitEvent(
  event: BaseEvent,
  config: PintaCodexConfig,
  opts: { trace: "current" | "new"; guard?: GuardResult | null },
): Promise<void> {
  const transport = new Transport(config);
  await transport.flush();
  const trace = new TraceManager(config);
  const traceId = opts.trace === "new" ? trace.newTrace() : trace.currentTrace();
  const payload = buildOtlpPayload({ event, traceId, guard: opts.guard });
  await transport.send(payload);
}
