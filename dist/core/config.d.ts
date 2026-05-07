export interface PintaCodexConfig {
    pluginRoot: string;
    pluginData: string;
    tracePath: string;
    endpoint?: string;
    headers: Record<string, string>;
    /** Plan 5: manager-local guard endpoint (or undefined → guard skipped). */
    guardEndpoint?: string;
}
export declare function loadConfig(): PintaCodexConfig;
/** Returns true if OTel endpoint is configured (signal to silently disable telemetry). */
export declare function hasOtlpEndpoint(config: PintaCodexConfig): boolean;
