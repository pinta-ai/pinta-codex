import fs from "fs";
import os from "os";
import path from "path";
import type { BaseEvent } from "./types.js";
import type { GuardResult } from "./guard.js";
import { ADAPTER_VERSION } from "./version.js";
import {
  attrsFromRecord,
  buildPayload,
  mergeBatch,
  snakeCase,
  type AttrPolicy,
  type GuardResult as CoreGuardResult,
  type OtlpAttribute,
  type OtlpPayload,
} from "@pinta-ai/core";

// os.userInfo() throws when the running uid has no /etc/passwd entry (containers
// with an arbitrary uid, some CI runners, service/launchd accounts). Memoize a
// safe lookup so resource attributes never abort span construction.
let cachedProcessOwner: string | undefined;
function processOwner(): string {
  if (cachedProcessOwner === undefined) {
    try {
      cachedProcessOwner = os.userInfo().username;
    } catch {
      cachedProcessOwner =
        process.env.USER ??
        process.env.LOGNAME ??
        (typeof process.getuid === "function" ? String(process.getuid()) : "unknown");
    }
  }
  return cachedProcessOwner;
}

// OTLP envelope + the redaction-aware attribute pipeline now live in
// @pinta-ai/core. This module keeps only the codex-specific bits: event
// flattening (incl. the `ingest.type` discriminator), resource attributes, CLI
// version resolution, and the redaction policy.
export { mergeBatch };
export type { OtlpPayload, OtlpAttribute };

const PLUGIN_VERSION = ADAPTER_VERSION;

/**
 * Resolve the Codex CLI version.
 *
 * `CODEX_CLI_VERSION` was the only source this used to read, and it is never
 * set. Dumping the full environment of a real codex hook child (codex 0.154.0,
 * `codex exec`) returned 69 variables; the codex-owned ones were exactly:
 *
 *   CODEX_HOME                  <session home>
 *   CODEX_MANAGED_BY_NPM        1
 *   CODEX_MANAGED_PACKAGE_ROOT  /opt/homebrew/lib/node_modules/@openai/codex
 *   CODEX_CLI_VERSION           unset    ← the only source this used to read
 *
 * The hook payload carries no version either, so `service.version` was the
 * literal string "unknown" on every span codex ever produced.
 *
 * Two real sources exist, in descending order of coverage:
 *
 *  1. The rollout transcript. Every hook payload carries `transcript_path`, and
 *     that file's first record is `{"type":"session_meta","payload":{…,
 *     "cli_version":"0.154.0",…}}`. This is codex reporting its own version, so
 *     it holds regardless of how codex was installed.
 *  2. `CODEX_MANAGED_PACKAGE_ROOT/package.json`. Exact, but npm installs only —
 *     the variable is absent for the standalone binary.
 *
 * `CODEX_CLI_VERSION` is kept last rather than dropped: reading it costs
 * nothing and it is the name codex would most plausibly adopt later.
 *
 * When nothing answers, the attribute is omitted rather than set to
 * `"unknown"`. A placeholder is indistinguishable from a real value downstream;
 * the attribute's absence is the honest signal (PTA-347, and the same choice
 * pinta-copilot makes).
 */
// `null` = resolved and nothing answered; `undefined` = not resolved yet.
let cachedCliVersion: string | null | undefined;

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

// The first line is large — 22 KB in the measured run, because session_meta
// embeds the full base instructions, and a project's own instruction files push
// it further — while `cli_version` sits at byte ~296 of it. Hooks are
// short-lived and latency-sensitive, so read a bounded prefix instead of the
// file: 256 KB is ~11x the measured first line and still a sub-millisecond read
// from page cache. If the line does not fit, fall through to the env tiers
// rather than growing the read.
const TRANSCRIPT_PREFIX_BYTES = 256 * 1024;

function versionFromTranscript(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.allocUnsafe(TRANSCRIPT_PREFIX_BYTES);
    const read = fs.readSync(fd, buf, 0, TRANSCRIPT_PREFIX_BYTES, 0);
    const prefix = buf.toString("utf8", 0, read);
    const nl = prefix.indexOf("\n");
    if (nl < 0) return undefined;
    const first = JSON.parse(prefix.slice(0, nl)) as {
      type?: string;
      payload?: { cli_version?: unknown };
    };
    if (first?.type !== "session_meta") return undefined;
    return nonEmpty(first.payload?.cli_version);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function versionFromPackageRoot(): string | undefined {
  const root = nonEmpty(process.env.CODEX_MANAGED_PACKAGE_ROOT);
  if (!root) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return nonEmpty(pkg.version);
  } catch {
    return undefined;
  }
}

function getCodexVersion(event?: BaseEvent): string | undefined {
  if (cachedCliVersion === undefined) {
    cachedCliVersion =
      versionFromTranscript(nonEmpty(event?.transcript_path)) ??
      versionFromPackageRoot() ??
      nonEmpty(process.env.CODEX_CLI_VERSION) ??
      null;
  }
  return cachedCliVersion ?? undefined;
}

/**
 * Attribute keys for which redaction (Tier 1) is skipped. Truncation (Tier 3)
 * still applies. These are identifiers, enums, or our own resource attrs that
 * are known-safe and where false-positive masking would hurt more than help.
 */
const SKIP_REDACT_KEYS: ReadonlySet<string> = new Set([
  "codex.hook",
  "codex.tool_name",
  "codex.tool_use_id",
  "codex.session_id",
  "codex.transcript_path",
  "codex.cwd",
  "codex.permission_mode",
]);

// flattenEvent emits codex.tool_input as a single JSON-stringified attribute (no
// nested flattening today), so strict equality matches actual behavior. If
// nested flattening is ever added, re-evaluate to avoid extending bash context
// to unrelated nested keys (e.g. codex.tool_input.file_path).
const BASH_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "codex.tool_input",
  "codex.tool_response",
]);

const ATTR_POLICY: AttrPolicy = {
  skipRedactKeys: SKIP_REDACT_KEYS,
  bashContextKeys: BASH_CONTEXT_KEYS,
};

function flattenEvent(event: BaseEvent): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  // Discriminator first so the Pinta backend's detectIngestType hits it cheaply.
  out.push({ key: "ingest.type", value: { stringValue: "codex" } });
  // Always set codex.hook explicitly so server queries have a canonical key
  // regardless of incoming field name.
  out.push({ key: "codex.hook", value: { stringValue: event.hook_event_name } });
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === "hook_event_name") continue; // covered by codex.hook above
    rest[k] = v;
  }
  out.push(...attrsFromRecord(rest, "codex", ATTR_POLICY));
  return out;
}

function resourceAttrs(event?: BaseEvent): OtlpAttribute[] {
  const version = getCodexVersion(event);
  return [
    { key: "service.name", value: { stringValue: "codex" } },
    // Omitted when unresolved — the absence is the honest signal, not "unknown".
    ...(version
      ? [{ key: "service.version", value: { stringValue: version } } as OtlpAttribute]
      : []),
    { key: "telemetry.sdk.name", value: { stringValue: "pinta-codex" } },
    { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
    { key: "telemetry.sdk.version", value: { stringValue: PLUGIN_VERSION } },
    { key: "process.pid", value: { intValue: process.pid } },
    { key: "process.owner", value: { stringValue: processOwner() } },
    { key: "host.name", value: { stringValue: os.hostname() } },
    { key: "host.arch", value: { stringValue: os.arch() } },
  ];
}

export function buildOtlpPayload(args: {
  event: BaseEvent;
  traceId: string; // ULID (26 chars)
  now?: number; // ms since epoch; injectable for tests
  guard?: GuardResult | null;
}): OtlpPayload {
  return buildPayload({
    traceId: args.traceId,
    spanName: `codex.${snakeCase(args.event.hook_event_name)}`,
    attributes: flattenEvent(args.event),
    resource: resourceAttrs(args.event),
    scope: { name: "pinta-codex", version: PLUGIN_VERSION },
    now: args.now,
    // codex's GuardResult intentionally omits the `userMessage` field that core
    // models. guardAttrs never reads it, so widening here is behavior-safe.
    guard: args.guard as CoreGuardResult | null | undefined,
  });
}
