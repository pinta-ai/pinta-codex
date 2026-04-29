import type { PintaCodexConfig } from "./config.js";
import type { OtlpPayload } from "./otlp.js";
export declare class Transport {
    private config;
    private queue;
    constructor(config: PintaCodexConfig);
    send(payload: OtlpPayload): Promise<void>;
    flush(): Promise<void>;
    private post;
}
