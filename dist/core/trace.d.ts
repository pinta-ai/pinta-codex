import type { PintaConfig } from "./config.js";
export declare class TraceManager {
    private tracePath;
    constructor(config: PintaConfig);
    /** Start a new trace for each user prompt hook. */
    newTrace(): string;
    /** Return the current trace id, creating one when needed. */
    currentTrace(): string;
    private save;
}
