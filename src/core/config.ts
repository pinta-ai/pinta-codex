import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHeadersEnv } from "@pinta-ai/core";

export interface PintaCodexConfig {
  pluginRoot: string;
  pluginData: string;
  tracePath: string;
  endpoint?: string;
  headers: Record<string, string>;
  /** Plan 5: manager-local guard endpoint (or undefined → guard skipped). */
  guardEndpoint?: string;
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
  // Per OTel spec:
  //   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = full URL (use as-is)
  //   OTEL_EXPORTER_OTLP_ENDPOINT        = base URL (append /v1/traces)
  // We treat values from manager (and the user-facing parity vars) as full URLs.
  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    envFile.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;
  const baseEndpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    envFile.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (baseEndpoint) return baseEndpoint.replace(/\/+$/, "") + "/v1/traces";
  return (
    process.env.PINTA_CODEX_ENDPOINT ??       // legacy (full URL)
    envFile.PINTA_CODEX_ENDPOINT ??           // legacy
    process.env.CLAUDE_PLUGIN_OPTION_ENDPOINT // parity (full URL)
  );
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
  const guardEndpoint =
    process.env.PINTA_GUARD_ENDPOINT ?? envFile.PINTA_GUARD_ENDPOINT;

  return {
    pluginRoot,
    pluginData,
    tracePath: path.join(pluginData, "trace.json"),
    endpoint: endpoint?.replace(/\/+$/, ""),
    headers: parseHeadersEnv(headersRaw ?? ""),
    guardEndpoint,
  };
}

/** Returns true if OTel endpoint is configured (signal to silently disable telemetry). */
export function hasOtlpEndpoint(config: PintaCodexConfig): boolean {
  return Boolean(config.endpoint);
}
