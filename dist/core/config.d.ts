export interface PintaCodexConfig {
    pluginRoot: string;
    pluginData: string;
    tracePath: string;
    endpoint?: string;
    headers: Record<string, string>;
}
export declare function loadConfig(): PintaCodexConfig;
/** Returns true if OTel endpoint is configured (signal to silently disable telemetry). */
export declare function hasOtlpEndpoint(config: PintaCodexConfig): boolean;
