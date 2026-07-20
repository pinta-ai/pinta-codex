import os from "os";
import type { BaseEvent } from "./types.js";
import type { GuardResult } from "./guard.js";
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

// OTLP envelope + the redaction-aware attribute pipeline now live in
// @pinta-ai/core. This module keeps only the codex-specific bits: event
// flattening (incl. the `ingest.type` discriminator), resource attributes, CLI
// version resolution, and the redaction policy.
export { mergeBatch };
export type { OtlpPayload, OtlpAttribute };

const PLUGIN_VERSION = "1.6.0"; // keep in sync with .codex-plugin/plugin.json

/**
 * Resolve the Codex CLI version from an explicit env if present.
 * Hooks run as short-lived processes, so we keep this intentionally simple.
 */
let cachedCliVersion: string | null = null;
function getCodexVersion(): string {
  if (cachedCliVersion !== null) return cachedCliVersion;
  cachedCliVersion = process.env.CODEX_CLI_VERSION || "unknown";
  return cachedCliVersion;
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

function resourceAttrs(): OtlpAttribute[] {
  return [
    { key: "service.name", value: { stringValue: "codex" } },
    { key: "service.version", value: { stringValue: getCodexVersion() } },
    { key: "telemetry.sdk.name", value: { stringValue: "pinta-codex" } },
    { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
    { key: "telemetry.sdk.version", value: { stringValue: PLUGIN_VERSION } },
    { key: "process.pid", value: { intValue: process.pid } },
    { key: "process.owner", value: { stringValue: os.userInfo().username } },
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
    resource: resourceAttrs(),
    scope: { name: "pinta-codex", version: PLUGIN_VERSION },
    now: args.now,
    // codex's GuardResult intentionally omits the `userMessage` field that core
    // models. guardAttrs never reads it, so widening here is behavior-safe.
    guard: args.guard as CoreGuardResult | null | undefined,
  });
}
