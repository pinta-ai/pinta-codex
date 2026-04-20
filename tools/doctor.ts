/**
 * Health check. Run when something looks off or before filing a bug.
 *
 *   npm run doctor
 *
 * Never mutates state — read-only. Exits 0 if everything is green, 1 if any
 * check fails. Yellow warnings do not fail the exit code.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CODEX_CONFIG_PATH,
  CODEX_ENV_PATH,
  CODEX_HOOKS_PATH,
  PLUGIN_ENTRY,
  PLUGIN_ROOT,
  countRegisteredEvents,
  isCodexHooksEnabled,
  readEnvFile,
  readJson,
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
const useColor = Boolean(process.stdout.isTTY);
const c = (code: string, s: string) => (useColor ? `${code}${s}${ANSI.reset}` : s);

type Status = "pass" | "warn" | "fail";
interface Result {
  status: Status;
  label: string;
  detail?: string;
  hint?: string;
}

const results: Result[] = [];
function pass(label: string, detail?: string): void {
  results.push({ status: "pass", label, detail });
}
function warn(label: string, detail: string, hint?: string): void {
  results.push({ status: "warn", label, detail, hint });
}
function fail(label: string, detail: string, hint?: string): void {
  results.push({ status: "fail", label, detail, hint });
}

// --- checks ---

function checkDist(): void {
  if (!fs.existsSync(PLUGIN_ENTRY)) {
    fail("dist/index.js", "missing", "Run 'npm run build' (or 'npm run setup').");
    return;
  }
  pass("dist/index.js", PLUGIN_ENTRY);
}

function checkEnv(): { endpoint?: string; apiKey?: string } {
  const fromFile = readEnvFile(CODEX_ENV_PATH);
  const endpoint = process.env.PINTA_CODEX_ENDPOINT || fromFile.PINTA_CODEX_ENDPOINT;
  const apiKey = process.env.PINTA_CODEX_API_KEY || fromFile.PINTA_CODEX_API_KEY;

  if (endpoint && apiKey) {
    const source = process.env.PINTA_CODEX_ENDPOINT ? "env" : "file";
    pass("endpoint + api key", `source=${source}, endpoint=${endpoint}`);
  } else if (endpoint) {
    fail("api key", "missing", "Run 'npm run setup' or set PINTA_CODEX_API_KEY.");
  } else if (apiKey) {
    fail("endpoint", "missing", "Run 'npm run setup' or set PINTA_CODEX_ENDPOINT.");
  } else {
    fail("config", "no env file and no env vars", "Run 'npm run setup'.");
  }
  return { endpoint, apiKey };
}

function checkCodexHooksFlag(): void {
  let content = "";
  try {
    content = fs.readFileSync(CODEX_CONFIG_PATH, "utf-8");
  } catch {
    fail(
      "codex_hooks flag",
      `${CODEX_CONFIG_PATH} not found`,
      "Run 'npm run setup' to create it.",
    );
    return;
  }
  if (isCodexHooksEnabled(content)) {
    pass("codex_hooks flag", "[features].codex_hooks = true");
  } else {
    fail(
      "codex_hooks flag",
      "not enabled in config.toml",
      "Add [features] codex_hooks = true, or run 'npm run setup'.",
    );
  }
}

function checkHooksRegistered(): void {
  if (!fs.existsSync(CODEX_HOOKS_PATH)) {
    fail(
      "hooks.json",
      `${CODEX_HOOKS_PATH} not found`,
      "Run 'npm run install-hooks' (or 'npm run setup').",
    );
    return;
  }
  const existing: HooksFile = readJson(CODEX_HOOKS_PATH, { hooks: {} });
  const registered = countRegisteredEvents(existing);
  if (registered === 0) {
    fail(
      "hooks.json",
      "no pinta-codex entries",
      "Run 'npm run install-hooks'.",
    );
    return;
  }
  pass("hooks.json", `${registered} event(s) registered`);

  for (const [eventName, matchers] of Object.entries(existing.hooks)) {
    for (const m of matchers) {
      for (const h of m.hooks) {
        if (!h.command.includes(PLUGIN_ENTRY)) continue;
        // Extract the file path from `node <abs-path>` and verify it exists.
        const parts = h.command.split(/\s+/);
        const script = parts[parts.length - 1];
        if (!fs.existsSync(script)) {
          warn(
            `hooks.json:${eventName}`,
            `command references missing file: ${script}`,
            "Plugin may have moved — run 'npm run install-hooks' from the current location.",
          );
        }
      }
    }
  }
}

function checkPintaCli(): void {
  const r = spawnSync("pinta", ["--version"], { timeout: 2000, encoding: "utf-8" });
  if (r.error || r.status !== 0) {
    fail(
      "pinta CLI",
      "not found or not executable",
      "Install the Pinta CLI, then 'pinta login'.",
    );
    return;
  }
  pass("pinta CLI", (r.stdout ?? "").trim());
}

function checkPintaIdentity(): void {
  const id = spawnSync("pinta", ["identity", "id"], { timeout: 2000, encoding: "utf-8" });
  const email = spawnSync("pinta", ["identity", "email"], { timeout: 2000, encoding: "utf-8" });
  const idOk = !id.error && id.status === 0 && (id.stdout ?? "").trim().length > 0;
  const emailOk = !email.error && email.status === 0 && (email.stdout ?? "").trim().length > 0;
  if (idOk && emailOk) {
    pass("pinta identity", `${(email.stdout ?? "").trim()}`);
    return;
  }
  fail(
    "pinta identity",
    "not authenticated",
    "Run 'pinta login', then 'pinta identity id' to verify.",
  );
}

async function checkEndpointReachability(endpoint?: string): Promise<void> {
  if (!endpoint) {
    warn("endpoint reachability", "skipped (no endpoint configured)");
    return;
  }
  const url = `${endpoint.replace(/\/+$/, "")}/traces`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    // HEAD /traces commonly returns 404 or 405 on POST-only backends (e.g.
    // Fastify won't auto-register HEAD for a POST route and falls through to
    // 404). Any HTTP response proves the host is reachable; we only fail on
    // transport-level errors (DNS, connect, TLS, timeout).
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    pass("endpoint reachability", `${url} → HTTP ${res.status}`);
  } catch (err) {
    fail(
      "endpoint reachability",
      `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "Check network / VPN / PINTA_CODEX_ENDPOINT value.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function checkRetryQueue(): void {
  const pluginData = process.env.CODEX_PLUGIN_DATA || path.join(PLUGIN_ROOT, ".plugin-data");
  const queuePath = path.join(pluginData, "failed-spans.jsonl");
  if (!fs.existsSync(queuePath)) {
    pass("retry queue", "empty");
    return;
  }
  const content = fs.readFileSync(queuePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0).length;
  if (lines === 0) {
    pass("retry queue", "empty");
  } else if (lines < 100) {
    pass("retry queue", `${lines} pending`);
  } else if (lines < 1000) {
    warn(
      "retry queue",
      `${lines} pending entries`,
      "Large backlog — next hook will try to drain. Check endpoint reachability.",
    );
  } else {
    fail(
      "retry queue",
      `${lines} entries (cap 1000)`,
      "Queue is full. Drops will occur. Fix transport then wait for flush.",
    );
  }
}

// --- reporter ---

function printResults(): number {
  process.stdout.write(c(ANSI.bold, "\nPinta Codex — health check\n\n"));
  let failed = 0;
  for (const r of results) {
    const glyph = r.status === "pass"
      ? c(ANSI.green, "✔")
      : r.status === "warn"
      ? c(ANSI.yellow, "!")
      : c(ANSI.red, "✘");
    const label = c(ANSI.bold, r.label.padEnd(24));
    const detail = r.detail ? c(ANSI.dim, r.detail) : "";
    process.stdout.write(`  ${glyph}  ${label}${detail}\n`);
    if (r.hint) {
      process.stdout.write(`      ${c(ANSI.cyan, "→ " + r.hint)}\n`);
    }
    if (r.status === "fail") failed++;
  }
  const summary = failed === 0
    ? c(ANSI.green, "\nAll checks passed.\n")
    : c(ANSI.red, `\n${failed} check(s) failed.\n`);
  process.stdout.write(summary);
  return failed === 0 ? 0 : 1;
}

// --- main ---

async function main(): Promise<void> {
  checkDist();
  const { endpoint } = checkEnv();
  checkCodexHooksFlag();
  checkHooksRegistered();
  checkPintaCli();
  checkPintaIdentity();
  await checkEndpointReachability(endpoint);
  checkRetryQueue();
  process.exit(printResults());
}

main();
