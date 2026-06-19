import type { PintaCodexConfig } from "../core/config.js";
import type { BaseEvent } from "../core/types.js";
import type { GuardResult } from "../core/guard.js";
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
export declare function emitEvent(event: BaseEvent, config: PintaCodexConfig, opts: {
    trace: "current" | "new";
    guard?: GuardResult | null;
}): Promise<void>;
