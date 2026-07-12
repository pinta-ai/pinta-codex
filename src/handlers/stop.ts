import type { PintaCodexConfig } from "../core/config.js";
import type { StopEvent } from "../core/types.js";
import { emitEvent } from "./emit.js";

export async function handleStop(
  event: StopEvent,
  config: PintaCodexConfig,
): Promise<number> {
  await emitEvent(event, config, { trace: "current" });
  return 0;
}
