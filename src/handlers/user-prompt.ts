import type { PintaCodexConfig } from "../core/config.js";
import type { UserPromptSubmitEvent } from "../core/types.js";
import { emitEvent } from "./emit.js";

export async function handleUserPrompt(
  event: UserPromptSubmitEvent,
  config: PintaCodexConfig,
): Promise<number> {
  await emitEvent(event, config, { trace: "new" }); // NEW trace per user turn
  return 0;
}
