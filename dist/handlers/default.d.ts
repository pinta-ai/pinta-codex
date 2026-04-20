import type { BaseEvent } from "../core/types.js";
/**
 * Catch-all for hooks Codex may add in the future that we do not route yet.
 * Exits 0 silently so unknown hooks stay fail-open.
 */
export declare function handleDefault(_event: BaseEvent): Promise<number>;
