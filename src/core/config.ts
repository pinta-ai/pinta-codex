import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PintaCodexConfig {
  pluginRoot: string;
  pluginData: string;
  tracePath: string;
  endpoint?: string;
  headers: Record<string, string>;
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

function resolveEndpoint(envFile: Record<string, string>): string | undefined {
  return process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ?? envFile.OTEL_EXPORTER_OTLP_ENDPOINT
    ?? process.env.PINTA_CODEX_ENDPOINT          // legacy
    ?? envFile.PINTA_CODEX_ENDPOINT              // legacy
    ?? process.env.CLAUDE_PLUGIN_OPTION_ENDPOINT // parity
    ?? undefined;
}

function resolveHeaders(envFile: Record<string, string>): string | undefined {
  // Primary: OTel-spec, already in `key=val,key=val` format
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) return process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (envFile.OTEL_EXPORTER_OTLP_HEADERS) return envFile.OTEL_EXPORTER_OTLP_HEADERS;
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

function parseHeadersString(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (k && rest.length > 0) out[k.trim()] = rest.join("=").trim();
  }
  return out;
}

export function loadConfig(): PintaCodexConfig {
  const pluginRoot = process.env.CODEX_PLUGIN_ROOT
    ?? process.env.CLAUDE_PLUGIN_ROOT
    ?? process.cwd();
  const pluginData = process.env.CODEX_PLUGIN_DATA
    ?? process.env.CLAUDE_PLUGIN_DATA
    ?? path.join(pluginRoot, ".plugin-data");
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const envFilePath = path.join(codexHome, "pinta-codex.env");
  const envFile = fs.existsSync(envFilePath) ? readEnvFile(envFilePath) : {};

  const endpoint = resolveEndpoint(envFile);
  const headersRaw = resolveHeaders(envFile);

  return {
    pluginRoot,
    pluginData,
    tracePath: path.join(pluginData, "trace.json"),
    endpoint: endpoint?.replace(/\/+$/, ""),
    headers: parseHeadersString(headersRaw ?? ""),
  };
}

/** Returns true if OTel endpoint is configured (signal to silently disable telemetry). */
export function hasOtlpEndpoint(config: PintaCodexConfig): boolean {
  return Boolean(config.endpoint);
}
