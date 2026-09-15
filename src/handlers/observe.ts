import type { PintaCodexConfig } from "../core/config.js";
import type { BaseEvent } from "../core/types.js";
import { emitEvent } from "./emit.js";

/**
 * Telemetry for the events that carry no refusal.
 *
 * `PostToolUse`, `SessionStart` and `Stop` each had their own one-line handler
 * that differed only in the type of their parameter. Adding six more lifecycle
 * events the same way would have produced six more copies of the same call,
 * and the copies are where a divergence hides — the `trace: "new"` in
 * `handleUserPrompt` is exactly such a difference, and it is a deliberate one
 * that deserves to stand out rather than sit among eight identical neighbours.
 *
 * These events cannot block. `SessionEnd` cannot even reply: the codex binary
 * ships a `session-end.command.input` schema with no matching `.output`, so
 * nothing is read back from it. Writing anything to stdout here would at best
 * be ignored and at worst parse as a malformed envelope, so this handler is
 * silent by construction.
 */
export async function handleObserve(
  event: BaseEvent,
  config: PintaCodexConfig,
): Promise<number> {
  await emitEvent(event, config, { trace: "current" });
  return 0;
}
