"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * Resolve config in this order (later wins, so env vars override the file):
 *   1. `~/.codex/pinta-codex.env` (KEY=VALUE per line, written by `npm run setup`)
 *   2. process.env (so one-off `PINTA_CODEX_ENDPOINT=... codex` still works)
 *   3. Claude-Code-style `CLAUDE_PLUGIN_OPTION_*` vars (parity with pinta-cc)
 */
function resolveSetting(fromFile, keys) {
    for (const k of keys) {
        if (process.env[k])
            return process.env[k];
    }
    for (const k of keys) {
        if (fromFile[k])
            return fromFile[k];
    }
    return undefined;
}
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
function loadConfig() {
    const pluginRoot = process.env.CODEX_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT ||
        process.cwd();
    const pluginData = process.env.CODEX_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA ||
        node_path_1.default.join(pluginRoot, ".plugin-data");
    const codexHome = process.env.CODEX_HOME || node_path_1.default.join(node_os_1.default.homedir(), ".codex");
    const fromFile = readEnvFile(node_path_1.default.join(codexHome, "pinta-codex.env"));
    const endpoint = resolveSetting(fromFile, [
        "PINTA_CODEX_ENDPOINT",
        "CLAUDE_PLUGIN_OPTION_ENDPOINT",
    ]);
    const apiKey = resolveSetting(fromFile, [
        "PINTA_CODEX_API_KEY",
        "CLAUDE_PLUGIN_OPTION_API_KEY",
    ]);
    if (!endpoint) {
        throw new Error("endpoint is not configured. Run 'npm run setup' or set PINTA_CODEX_ENDPOINT.");
    }
    if (!apiKey) {
        throw new Error("api_key is not configured. Run 'npm run setup' or set PINTA_CODEX_API_KEY.");
    }
    return {
        endpoint: endpoint.replace(/\/+$/, ""),
        apiKey,
        pluginRoot,
        pluginData,
        rulesPath: node_path_1.default.join(pluginData, "rules.json"),
        healthPath: node_path_1.default.join(pluginData, "health.json"),
        tracePath: node_path_1.default.join(pluginData, "trace.json"),
    };
}
//# sourceMappingURL=config.js.map