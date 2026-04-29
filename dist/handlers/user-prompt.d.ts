import type { PintaCodexConfig } from "../core/config.js";
import type { UserPromptSubmitEvent } from "../core/types.js";
export declare function handleUserPrompt(event: UserPromptSubmitEvent, config: PintaCodexConfig): Promise<number>;
