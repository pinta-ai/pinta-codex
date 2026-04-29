/**
 * Shared helpers for setup / doctor / install-hooks / uninstall-hooks.
 *
 * Keeps path resolution, config-file I/O, and TOML toggling in one place so
 * the scripts stay thin and stay consistent.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const PLUGIN_ROOT = path.resolve(__dirname, "..");
export const PLUGIN_ENTRY = path.join(PLUGIN_ROOT, "dist", "index.js");

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const CODEX_HOOKS_PATH = path.join(CODEX_HOME, "hooks.json");
export const CODEX_CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
export const CODEX_ENV_PATH = path.join(CODEX_HOME, "pinta-codex.env");

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}
export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
export interface HooksFile {
  hooks: Record<string, HookMatcher[]>;
}

// --- JSON helpers ---

export function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

// --- env file ("KEY=VALUE" per line) ---

export function readEnvFile(p: string): Record<string, string> {
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

export function writeEnvFile(p: string, values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(p, body + "\n", "utf-8");
}

/**
 * Migrate legacy `PINTA_CODEX_*` keys to OTel-spec names.
 * - PINTA_CODEX_ENDPOINT → OTEL_EXPORTER_OTLP_ENDPOINT
 * - PINTA_CODEX_API_KEY  → OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=<value>
 *
 * If migration occurs, writes `<path>.bak` with the original content first
 * (idempotent — won't overwrite an existing .bak), then writes the file with
 * the new keys. Existing OTel-spec keys win and are preserved as-is.
 *
 * Returns the list of legacy keys that were migrated, or empty array if no
 * migration was needed.
 */
export function migrateLegacyEnvKeys(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  const original = fs.readFileSync(p, "utf-8");
  const values = readEnvFile(p);
  const renamed: string[] = [];

  if (values.PINTA_CODEX_ENDPOINT && !values.OTEL_EXPORTER_OTLP_ENDPOINT) {
    values.OTEL_EXPORTER_OTLP_ENDPOINT = values.PINTA_CODEX_ENDPOINT;
    delete values.PINTA_CODEX_ENDPOINT;
    renamed.push("PINTA_CODEX_ENDPOINT");
  }
  if (values.PINTA_CODEX_API_KEY && !values.OTEL_EXPORTER_OTLP_HEADERS) {
    values.OTEL_EXPORTER_OTLP_HEADERS = `x-pinta-relay-token=${values.PINTA_CODEX_API_KEY}`;
    delete values.PINTA_CODEX_API_KEY;
    renamed.push("PINTA_CODEX_API_KEY");
  }

  if (renamed.length === 0) return [];

  const bakPath = `${p}.bak`;
  if (!fs.existsSync(bakPath)) {
    fs.writeFileSync(bakPath, original, "utf-8");
  }
  writeEnvFile(p, values);
  return renamed;
}

// --- TOML: minimal, targeted `[features].codex_hooks = true` toggle ---

/**
 * Ensure `[features] codex_hooks = true` is set in the TOML source.
 * Preserves unrelated content; only touches the features section.
 *
 * Handles:
 *   - no file / empty file  → append section
 *   - no [features] section → append section
 *   - [features] present, key missing → insert key
 *   - key present with different value → replace value
 *   - key already true → no change
 */
export function ensureCodexHooksEnabled(content: string): {
  next: string;
  changed: boolean;
} {
  const sectionHeader = /^\[features\]\s*$/m;
  const match = content.match(sectionHeader);
  if (!match) {
    const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    const suffix = content.length === 0 ? "" : "\n";
    return {
      next: content + sep + suffix + "[features]\ncodex_hooks = true\n",
      changed: true,
    };
  }

  const sectionStart = match.index! + match[0].length;
  const rest = content.slice(sectionStart);
  const nextSection = rest.match(/\n\[[^\]]+\]\s*$/m);
  const sectionEnd = nextSection ? sectionStart + nextSection.index! : content.length;
  const body = content.slice(sectionStart, sectionEnd);

  const keyRe = /^(\s*)codex_hooks\s*=\s*(true|false|"[^"]*"|'[^']*')\s*$/m;
  const keyMatch = body.match(keyRe);
  if (keyMatch) {
    if (keyMatch[2] === "true") return { next: content, changed: false };
    const replaced = body.replace(keyRe, `${keyMatch[1] ?? ""}codex_hooks = true`);
    return {
      next: content.slice(0, sectionStart) + replaced + content.slice(sectionEnd),
      changed: true,
    };
  }

  const sep = body.length === 0 || body.endsWith("\n") ? "" : "\n";
  const insert = `${sep}codex_hooks = true\n`;
  return {
    next: content.slice(0, sectionStart) + body + insert + content.slice(sectionEnd),
    changed: true,
  };
}

export function isCodexHooksEnabled(content: string): boolean {
  const sectionHeader = /^\[features\]\s*$/m;
  const match = content.match(sectionHeader);
  if (!match) return false;
  const sectionStart = match.index! + match[0].length;
  const rest = content.slice(sectionStart);
  const nextSection = rest.match(/\n\[[^\]]+\]\s*$/m);
  const sectionEnd = nextSection ? sectionStart + nextSection.index! : content.length;
  const body = content.slice(sectionStart, sectionEnd);
  const keyRe = /^\s*codex_hooks\s*=\s*(true|"true"|'true')\s*$/m;
  return keyRe.test(body);
}

// --- hooks.json merge ---

const STALE_PINTA_CODEX_RE = /\/pinta-codex(?:\/[^\s]*)?\/dist\/index\.js\b/;

export function isPintaCodexEntry(cmd: HookCommand): boolean {
  if (cmd.command.includes(PLUGIN_ENTRY)) return true;
  return STALE_PINTA_CODEX_RE.test(cmd.command);
}

/** True when the entry points at a pinta-codex path other than the current PLUGIN_ENTRY. */
export function isStalePintaCodexEntry(cmd: HookCommand): boolean {
  if (cmd.command.includes(PLUGIN_ENTRY)) return false;
  return STALE_PINTA_CODEX_RE.test(cmd.command);
}

/** Load the plugin's bundled template and resolve ${CODEX_PLUGIN_ROOT} → PLUGIN_ROOT. */
export function loadResolvedTemplate(): HooksFile {
  const templatePath = path.join(PLUGIN_ROOT, "hooks.json");
  const template: HooksFile = readJson(templatePath, { hooks: {} });
  const out: HooksFile = { hooks: {} };
  for (const [eventName, matchers] of Object.entries(template.hooks)) {
    out.hooks[eventName] = matchers.map((m) => ({
      ...m,
      hooks: m.hooks.map((h) => ({
        ...h,
        command: h.command.replace(/\$\{CODEX_PLUGIN_ROOT\}/g, PLUGIN_ROOT),
      })),
    }));
  }
  return out;
}

/**
 * Merge `incoming` into `existing`, removing any prior pinta-codex entries
 * first (both exact-path matches and stale entries from prior installs that
 * used a different path).
 */
export function mergeHooks(
  existing: HooksFile,
  incoming: HooksFile,
): { next: HooksFile; staleRemoved: number } {
  const merged: HooksFile = { hooks: { ...existing.hooks } };
  let staleRemoved = 0;
  for (const [eventName, incomingMatchers] of Object.entries(incoming.hooks)) {
    const current = merged.hooks[eventName] ?? [];
    const cleaned = current
      .map((m) => {
        const staleBefore = m.hooks.filter((h) => isStalePintaCodexEntry(h)).length;
        staleRemoved += staleBefore;
        const kept = m.hooks.filter((h) => !isPintaCodexEntry(h));
        return { ...m, hooks: kept };
      })
      .filter((m) => m.hooks.length > 0);
    merged.hooks[eventName] = [...cleaned, ...incomingMatchers];
  }
  return { next: merged, staleRemoved };
}

export function stripPintaCodex(existing: HooksFile): {
  next: HooksFile;
  removed: number;
} {
  const cleaned: HooksFile = { hooks: {} };
  let removed = 0;
  for (const [eventName, matchers] of Object.entries(existing.hooks)) {
    const next = matchers
      .map((m) => {
        const before = m.hooks.length;
        const kept = m.hooks.filter((h) => !isPintaCodexEntry(h));
        removed += before - kept.length;
        return { ...m, hooks: kept };
      })
      .filter((m) => m.hooks.length > 0);
    if (next.length > 0) cleaned.hooks[eventName] = next;
  }
  return { next: cleaned, removed };
}

export function countRegisteredEvents(existing: HooksFile): number {
  let n = 0;
  for (const matchers of Object.values(existing.hooks)) {
    for (const m of matchers) {
      if (m.hooks.some((h) => isPintaCodexEntry(h))) {
        n++;
        break;
      }
    }
  }
  return n;
}
