import { DiskTransport } from "@pinta-ai/core";
import type { PintaCodexConfig } from "./config.js";
export declare class Transport extends DiskTransport {
    constructor(config: PintaCodexConfig);
}
