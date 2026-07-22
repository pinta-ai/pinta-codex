/**
 * One-shot installer for end users.
 *
 *   npm install && npm run setup
 *
 * Does everything a user needs in a single interactive command:
 *   1. Builds dist/  (runs tsc if dist/index.js missing or --rebuild)
 *   2. Prompts for OTLP endpoint & headers (migrates legacy keys if present)
 *   3. Writes them to ~/.codex/pinta-codex.env
 *   4. Enables `codex_hooks = true` in ~/.codex/config.toml (idempotent)
 *   5. Merges this plugin's hooks into ~/.codex/hooks.json with absolute paths
 *   6. Prints a summary of what to run next
 *
 * Safe to re-run. Each step is idempotent.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import {
  CODEX_CONFIG_PATH,
  CODEX_ENV_PATH,
  CODEX_HOME,
  CODEX_HOOKS_PATH,
  PLUGIN_ENTRY,
  PLUGIN_ROOT,
  ensureCodexHooksEnabled,
  loadResolvedTemplate,
  mergeHooks,
  migrateLegacyEnvKeys,
  readEnvFile,
  readJsonAllowMissing,
  writeEnvFile,
  type HooksFile,
} from "./_lib.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function tty(): boolean {
  return Boolean(stdout.isTTY);
}
function ok(msg: string): void {
  const mark = tty() ? `${ANSI.green}✔${ANSI.reset}` : "OK";
  stdout.write(`  ${mark}  ${msg}\n`);
}
function info(msg: string): void {
  const mark = tty() ? `${ANSI.cyan}ℹ${ANSI.reset}` : "--";
  stdout.write(`  ${mark}  ${msg}\n`);
}
function heading(title: string): void {
  stdout.write(
    tty() ? `\n${ANSI.bold}${title}${ANSI.reset}\n` : `\n## ${title}\n`,
  );
}

// --- steps ---

async function stepBuild(): Promise<void> {
  heading("1. Build dist/");
  const rebuild = process.argv.includes("--rebuild");
  if (fs.existsSync(PLUGIN_ENTRY) && !rebuild) {
    ok(`dist/index.js already present (pass --rebuild to force)`);
    return;
  }
  info("running tsc...");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: PLUGIN_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    stderrFail(`tsc failed with exit ${result.status}`);
  }
  ok(`built ${PLUGIN_ENTRY}`);
}

async function stepEnv(ask: AskFn): Promise<{ endpoint: string; headers: string }> {
  heading("2. OTLP endpoint & headers");

  // Migrate legacy keys to OTel-spec naming (writes .bak if migration occurs)
  const renamed = migrateLegacyEnvKeys(CODEX_ENV_PATH);
  for (const key of renamed) {
    info(`migrated legacy key ${key} → OTel-spec name (.bak written)`);
  }

  const existingFile = readEnvFile(CODEX_ENV_PATH);
  const currentEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ?? existingFile.OTEL_EXPORTER_OTLP_ENDPOINT
    ?? "http://localhost:4318";
  const currentHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS
    ?? existingFile.OTEL_EXPORTER_OTLP_HEADERS
    ?? "";

  const endpoint = await ask("OTLP endpoint URL", currentEndpoint, {
    validate: (v) => /^https?:\/\//.test(v) ? null : "must start with http:// or https://",
  });
  const headers = await ask("OTLP headers (key1=val1,key2=val2; blank if none)", currentHeaders, {
    mask: true,
    optional: true,
  });

  const merged: Record<string, string> = {
    ...existingFile,
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  };
  if (headers) {
    merged.OTEL_EXPORTER_OTLP_HEADERS = headers;
  } else {
    delete merged.OTEL_EXPORTER_OTLP_HEADERS;
  }
  writeEnvFile(CODEX_ENV_PATH, merged);
  ok(`wrote ${CODEX_ENV_PATH}`);
  return { endpoint, headers };
}

async function stepConfigToml(): Promise<void> {
  heading("3. Enable codex_hooks feature");
  let current = "";
  try {
    current = fs.readFileSync(CODEX_CONFIG_PATH, "utf-8");
  } catch {
    // file may not exist yet
  }
  const { next, changed } = ensureCodexHooksEnabled(current);
  if (!changed) {
    ok(`codex_hooks already enabled in ${CODEX_CONFIG_PATH}`);
    return;
  }
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.writeFileSync(CODEX_CONFIG_PATH, next, "utf-8");
  ok(`updated ${CODEX_CONFIG_PATH}`);
}

async function stepHooks(): Promise<void> {
  heading("4. Register hooks");
  const incoming = loadResolvedTemplate();
  const existing: HooksFile = readJsonAllowMissing(CODEX_HOOKS_PATH, { hooks: {} });
  const { next: merged, staleRemoved } = mergeHooks(existing, incoming);
  const serialized = JSON.stringify(merged, null, 2) + "\n";
  const previous = fs.existsSync(CODEX_HOOKS_PATH)
    ? fs.readFileSync(CODEX_HOOKS_PATH, "utf-8")
    : null;
  if (previous === serialized) {
    ok(`${Object.keys(incoming.hooks).length} event(s) already registered in ${CODEX_HOOKS_PATH}`);
    return;
  }
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.writeFileSync(CODEX_HOOKS_PATH, serialized, "utf-8");
  if (staleRemoved > 0) {
    ok(`removed ${staleRemoved} stale pinta-codex ${staleRemoved === 1 ? "entry" : "entries"} (prior install at a different path)`);
  }
  ok(`wrote ${Object.keys(incoming.hooks).length} event(s) to ${CODEX_HOOKS_PATH}`);
}

async function stepSummary(endpoint: string): Promise<void> {
  heading("Done");
  stdout.write(
    `  Run Codex to start streaming events:\n` +
      `    ${tty() ? ANSI.bold : ""}codex${tty() ? ANSI.reset : ""}\n` +
      `\n  Useful:\n` +
      `    npm run doctor          # health check\n` +
      `    npm run uninstall-hooks # remove this plugin's entries\n` +
      `\n  Endpoint: ${endpoint}\n` +
      `  Env file: ${CODEX_ENV_PATH}\n` +
      `  Hooks:    ${CODEX_HOOKS_PATH}\n`,
  );
}

// --- helpers ---

function stderrFail(msg: string): never {
  process.stderr.write(`[setup] ${msg}\n`);
  process.exit(1);
}

interface PromptOpts {
  mask?: boolean;
  optional?: boolean;
  validate?: (v: string) => string | null;
}

type AskFn = (label: string, defaultValue: string, opts?: PromptOpts) => Promise<string>;

/**
 * Build an ask() function that works in two modes:
 *   - TTY: classic readline prompt loop with validation retries.
 *   - Piped stdin (non-TTY): read all stdin upfront, consume one line per
 *     question. We cannot retry a rejected value because there's no more input
 *     — rejections throw instead.
 *
 * Why the split: node:readline/promises' `rl.question` hangs on the 2nd call
 * when stdin is piped, making an interactive-only implementation unusable for
 * scripted/CI setup runs.
 */
function buildAsk(): AskFn {
  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const question = (prompt: string): Promise<string> =>
      new Promise((resolve) => rl.question(prompt, resolve));
    const ask: AskFn = async (label, defaultValue, opts = {}) => {
      const shown = opts.mask && defaultValue ? "***" : defaultValue;
      const suffix = defaultValue ? ` [${shown}]` : "";
      while (true) {
        const answer = (await question(`  ${label}${suffix}: `)).trim();
        const value = answer === "" ? defaultValue : answer;
        if (!value && !opts.optional) {
          stdout.write(`    (required)\n`);
          continue;
        }
        const err = opts.validate?.(value);
        if (err) {
          stdout.write(`    ${tty() ? ANSI.red : ""}${err}${tty() ? ANSI.reset : ""}\n`);
          continue;
        }
        return value;
      }
    };
    (ask as AskFn & { close: () => void }).close = () => rl.close();
    return ask;
  }

  // Non-TTY: slurp all lines eagerly.
  const lines: string[] = [];
  let drained = false;
  let pending: Array<() => void> = [];
  const drain = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    for (const raw of text.split("\n")) lines.push(raw);
    // Split leaves a trailing empty element if input ended with \n; keep it
    // because it's a legitimate "user pressed enter with nothing" answer.
  };
  stdin.on("data", drain);
  stdin.once("end", () => {
    drained = true;
    const waiters = pending;
    pending = [];
    for (const w of waiters) w();
  });

  const waitForDrain = (): Promise<void> =>
    drained ? Promise.resolve() : new Promise((resolve) => pending.push(resolve));

  const ask: AskFn = async (label, defaultValue, opts = {}) => {
    await waitForDrain();
    const raw = lines.shift();
    const answer = (raw ?? "").trim();
    const value = answer === "" ? defaultValue : answer;
    if (!value && !opts.optional) {
      throw new Error(`${label}: required (stdin exhausted).`);
    }
    const err = opts.validate?.(value);
    if (err) {
      throw new Error(`${label}: ${err}`);
    }
    return value;
  };
  return ask;
}

// --- main ---

async function main(): Promise<void> {
  stdout.write(
    tty()
      ? `\n${ANSI.bold}Pinta Codex — one-shot setup${ANSI.reset}\n`
      : `\nPinta Codex — one-shot setup\n`,
  );
  const ask = buildAsk();
  try {
    await stepBuild();
    const { endpoint } = await stepEnv(ask);
    await stepConfigToml();
    await stepHooks();
    await stepSummary(endpoint);
  } finally {
    (ask as AskFn & { close?: () => void }).close?.();
  }
}

main().catch((err) => stderrFail(err instanceof Error ? err.message : String(err)));
