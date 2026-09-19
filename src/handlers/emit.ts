import type { OtlpPayload } from "@pinta-ai/core";
import type { PintaCodexConfig } from "../core/config.js";
import type { BaseEvent } from "../core/types.js";
import { Transport } from "../core/transport.js";
import { TraceManager } from "../core/trace.js";
import { buildOtlpPayload } from "../core/otlp.js";

/**
 * The span for a hook event, before anything has been decided about it.
 *
 * Split out of `emitEvent` so a gate can build the payload, ask the guard about
 * that very object, attach the verdict, and then send it — the manager judges
 * the span the backend will store, not a second reading of the event.
 *
 * `trace` selects how the trace id is resolved:
 *   - "current": reuse the active trace (PreToolUse, PostToolUse, Session, Stop)
 *   - "new":     rotate a fresh trace (UserPromptSubmit — one trace per turn)
 */
export function buildEventPayload(
  event: BaseEvent,
  config: PintaCodexConfig,
  opts: { trace: "current" | "new" },
): OtlpPayload {
  const trace = new TraceManager(config);
  const traceId = opts.trace === "new" ? trace.newTrace() : trace.currentTrace();
  return buildOtlpPayload({ event, traceId });
}

/** Flush any queued spans, then send this one. */
export async function sendPayload(payload: OtlpPayload, config: PintaCodexConfig): Promise<void> {
  const transport = new Transport(config);
  await transport.flush();
  await transport.send(payload);
}

/**
 * Shared telemetry flow for the non-gating event handlers: resolve the trace
 * id, build the OTLP payload, flush any queued spans, and send it.
 */
export async function emitEvent(
  event: BaseEvent,
  config: PintaCodexConfig,
  opts: { trace: "current" | "new" },
): Promise<void> {
  await sendPayload(buildEventPayload(event, config, opts), config);
}
