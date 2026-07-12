import type { PintaCodexConfig } from "../core/config.js";
import type { SessionEvent } from "../core/types.js";
import { emitEvent } from "./emit.js";

export async function handleSession(
  event: SessionEvent,
  config: PintaCodexConfig,
): Promise<number> {
  await emitEvent(event, config, { trace: "current" });
  return 0;
}
