"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitEvent = emitEvent;
const transport_js_1 = require("../core/transport.js");
const trace_js_1 = require("../core/trace.js");
const otlp_js_1 = require("../core/otlp.js");
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
async function emitEvent(event, config, opts) {
    const transport = new transport_js_1.Transport(config);
    await transport.flush();
    const trace = new trace_js_1.TraceManager(config);
    const traceId = opts.trace === "new" ? trace.newTrace() : trace.currentTrace();
    const payload = (0, otlp_js_1.buildOtlpPayload)({ event, traceId, guard: opts.guard });
    await transport.send(payload);
}
//# sourceMappingURL=emit.js.map