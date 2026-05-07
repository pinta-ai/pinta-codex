"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.hasOtlpEndpoint = hasOtlpEndpoint;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
function readEnvFile(p) {
    const out = {};
    let content;
    try {
        content = node_fs_1.default.readFileSync(p, "utf-8");
    }
    catch {
        return out;
    }
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const idx = line.indexOf("=");
        if (idx < 0)
            continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key)
            out[key] = value;
    }
    return out;
}
function resolveEndpoint(envFile) {
    // Per OTel spec:
    //   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = full URL (use as-is)
    //   OTEL_EXPORTER_OTLP_ENDPOINT        = base URL (append /v1/traces)
    // We treat values from manager (and the user-facing parity vars) as full URLs.
    const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        envFile.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (tracesEndpoint)
        return tracesEndpoint;
    const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
        envFile.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (baseEndpoint)
        return baseEndpoint.replace(/\/+$/, "") + "/v1/traces";
    return (process.env.PINTA_CODEX_ENDPOINT ?? // legacy (full URL)
        envFile.PINTA_CODEX_ENDPOINT ?? // legacy
        process.env.CLAUDE_PLUGIN_OPTION_ENDPOINT // parity (full URL)
    );
}
function resolveHeaders(envFile) {
    // Primary: OTel-spec, already in `key=val,key=val` format
    if (process.env.OTEL_EXPORTER_OTLP_HEADERS)
        return process.env.OTEL_EXPORTER_OTLP_HEADERS;
    if (envFile.OTEL_EXPORTER_OTLP_HEADERS)
        return envFile.OTEL_EXPORTER_OTLP_HEADERS;
    // Legacy: raw token → wrap as x-pinta-relay-token header
    if (process.env.PINTA_CODEX_API_KEY) {
        return `x-pinta-relay-token=${process.env.PINTA_CODEX_API_KEY}`;
    }
    if (envFile.PINTA_CODEX_API_KEY) {
        return `x-pinta-relay-token=${envFile.PINTA_CODEX_API_KEY}`;
    }
    // Parity: Claude Code-style userConfig env (raw token, same wrap)
    if (process.env.CLAUDE_PLUGIN_OPTION_API_KEY) {
        return `x-pinta-relay-token=${process.env.CLAUDE_PLUGIN_OPTION_API_KEY}`;
    }
    return undefined;
}
function parseHeadersString(raw) {
    const out = {};
    if (!raw)
        return out;
    for (const pair of raw.split(",")) {
        const [k, ...rest] = pair.split("=");
        if (k && rest.length > 0)
            out[k.trim()] = rest.join("=").trim();
    }
    return out;
}
function loadConfig() {
    const pluginRoot = process.env.CODEX_PLUGIN_ROOT
        ?? process.env.CLAUDE_PLUGIN_ROOT
        ?? process.cwd();
    const pluginData = process.env.CODEX_PLUGIN_DATA
        ?? process.env.CLAUDE_PLUGIN_DATA
        ?? node_path_1.default.join(pluginRoot, ".plugin-data");
    const codexHome = process.env.CODEX_HOME ?? node_path_1.default.join(node_os_1.default.homedir(), ".codex");
    const envFilePath = node_path_1.default.join(codexHome, "pinta-codex.env");
    const envFile = node_fs_1.default.existsSync(envFilePath) ? readEnvFile(envFilePath) : {};
    const endpoint = resolveEndpoint(envFile);
    const headersRaw = resolveHeaders(envFile);
    // Plan 5: expose relay token for guard.ts (~/guard/evaluate auth header).
    // Parse x-pinta-relay-token from the resolved OTEL headers string so guard.ts
    // can read it from process.env.PINTA_RELAY_TOKEN (same as pinta-cc pattern).
    if (headersRaw && !process.env.PINTA_RELAY_TOKEN) {
        const tokenMatch = headersRaw.match(/x-pinta-relay-token=([^,\s]+)/i);
        if (tokenMatch) {
            process.env.PINTA_RELAY_TOKEN = tokenMatch[1];
        }
    }
    // Plan 5 v1.2.4: codex CLI does NOT inject pinta-codex.env into hook
    // subprocess env (unlike Claude Code's settings.json env-prefix). The hook
    // must read PINTA_GUARD_ENDPOINT from envFile too — not just process.env.
    // Same pattern as resolveEndpoint/resolveHeaders above.
    const guardEndpoint = process.env.PINTA_GUARD_ENDPOINT ?? envFile.PINTA_GUARD_ENDPOINT;
    return {
        pluginRoot,
        pluginData,
        tracePath: node_path_1.default.join(pluginData, "trace.json"),
        endpoint: endpoint?.replace(/\/+$/, ""),
        headers: parseHeadersString(headersRaw ?? ""),
        guardEndpoint,
    };
}
/** Returns true if OTel endpoint is configured (signal to silently disable telemetry). */
function hasOtlpEndpoint(config) {
    return Boolean(config.endpoint);
}
//# sourceMappingURL=config.js.map