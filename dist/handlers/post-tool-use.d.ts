import type { PintaConfig } from "../core/config.js";
import type { PostToolUseEvent } from "../core/types.js";
import type { IdentityResolver } from "../core/identity.js";
export declare function handlePostToolUse(event: PostToolUseEvent, config: PintaConfig, identityResolver: IdentityResolver): Promise<number>;
