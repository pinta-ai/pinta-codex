import type { PintaCodexConfig } from "../core/config.js";
import type { PostToolUseEvent } from "../core/types.js";
import { emitEvent } from "./emit.js";

export async function handlePostToolUse(
  event: PostToolUseEvent,
  config: PintaCodexConfig,
): Promise<number> {
  await emitEvent(event, config, { trace: "current" });
  return 0;
}
