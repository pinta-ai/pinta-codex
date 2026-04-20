import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PintaConfig {
  endpoint: string;
  apiKey: string;
  pluginRoot: string;
  pluginData: string;
  rulesPath: string;
  healthPath: string;
  tracePath: string;
}

/**
 * Resolve config in this order (later wins, so env vars override the file):
 *   1. `~/.codex/pinta-codex.env` (KEY=VALUE per line, written by `npm run setup`)
 *   2. process.env (so one-off `PINTA_CODEX_ENDPOINT=... codex` still works)
 *   3. Claude-Code-style `CLAUDE_PLUGIN_OPTION_*` vars (parity with pinta-cc)
 */
function resolveSetting(fromFile: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    if (process.env[k]) return process.env[k];
  }
  for (const k of keys) {
    if (fromFile[k]) return fromFile[k];
  }
  return undefined;
}

function readEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch {
    return out;
  }
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadConfig(): PintaConfig {
  const pluginRoot = process.env.CODEX_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT ||
    process.cwd();
  const pluginData = process.env.CODEX_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA ||
    path.join(pluginRoot, ".plugin-data");

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const fromFile = readEnvFile(path.join(codexHome, "pinta-codex.env"));

  const endpoint = resolveSetting(fromFile, [
    "PINTA_CODEX_ENDPOINT",
    "CLAUDE_PLUGIN_OPTION_ENDPOINT",
  ]);
  const apiKey = resolveSetting(fromFile, [
    "PINTA_CODEX_API_KEY",
    "CLAUDE_PLUGIN_OPTION_API_KEY",
  ]);

  if (!endpoint) {
    throw new Error(
      "endpoint is not configured. Run 'npm run setup' or set PINTA_CODEX_ENDPOINT.",
    );
  }
  if (!apiKey) {
    throw new Error(
      "api_key is not configured. Run 'npm run setup' or set PINTA_CODEX_API_KEY.",
    );
  }

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    pluginRoot,
    pluginData,
    rulesPath: path.join(pluginData, "rules.json"),
    healthPath: path.join(pluginData, "health.json"),
    tracePath: path.join(pluginData, "trace.json"),
  };
}
