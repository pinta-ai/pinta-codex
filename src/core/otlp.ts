import crypto from "crypto";
import os from "os";
import type { BaseEvent } from "./types.js";
import { redact, truncate } from "./redact.js";

const PLUGIN_VERSION = "1.2.0"; // keep in sync with .codex-plugin/plugin.json

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

export interface OtlpAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: number }
    | { doubleValue: number }
    | { boolValue: boolean };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}

export interface ResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: Array<{
    scope: { name: string; version: string };
    spans: OtlpSpan[];
  }>;
}

export interface OtlpPayload {
  resourceSpans: ResourceSpans[];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Convert a 26-char Crockford ULID into 32 lowercase hex chars (16 bytes)
 * suitable for an OTLP traceId. Decoding is straightforward because each
 * Crockford char carries 5 bits and 26 chars = 130 bits; we keep the low
 * 128 bits (the spec already pads timestamp+randomness into 128 bits).
 */
export function ulidToTraceId(ulid: string): string {
  if (ulid.length !== 26) {
    throw new Error(`ulidToTraceId: expected 26 chars, got ${ulid.length}`);
  }
  // Decode to a BigInt then to 16-byte big-endian buffer.
  let n = 0n;
  for (const ch of ulid) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new Error(`ulidToTraceId: invalid Crockford char "${ch}"`);
    n = (n << 5n) | BigInt(idx);
  }
  // Mask to 128 bits (drop the top 2 bits of the 130-bit decode).
  const mask = (1n << 128n) - 1n;
  n &= mask;
  // Render as 32 hex chars, lowercase.
  return n.toString(16).padStart(32, "0");
}

/** Generate a fresh 16-hex-char (8-byte) span ID. */
export function newSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
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

function maybeRedactString(key: string, raw: string): string {
  // Spec §3: truncate first, then redact.
  const truncated = truncate(raw);
  if (SKIP_REDACT_KEYS.has(key)) return truncated;
  // Bash context only applies when this key may carry shell command text.
  // flattenEvent emits codex.tool_input as a single JSON-stringified attribute
  // (no nested flattening today), so strict equality matches actual behavior.
  // If nested flattening is ever added, re-evaluate to avoid extending bash
  // context to unrelated nested keys (e.g. codex.tool_input.file_path).
  const context = key === "codex.tool_input" || key === "codex.tool_response"
    ? ("bash" as const)
    : undefined;
  return redact(truncated, { context });
}

/** Convert a JS value into an OTLP attribute value. Returns null to omit. */
function toOtlpValue(key: string, v: unknown): OtlpAttribute["value"] | null {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case "string":
      return { stringValue: maybeRedactString(key, v) };
    case "boolean":
      return { boolValue: v };
    case "number":
      if (Number.isInteger(v)) return { intValue: v };
      return { doubleValue: v };
    case "object":
      try {
        return { stringValue: maybeRedactString(key, JSON.stringify(v)) };
      } catch {
        return { stringValue: maybeRedactString(key, String(v)) };
      }
    default:
      return { stringValue: maybeRedactString(key, String(v)) };
  }
}

function snakeCase(hookEventName: string): string {
  // "PreToolUse" → "pre_tool_use"
  return hookEventName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function flattenEvent(event: BaseEvent): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  // Discriminator first so the Pinta backend's detectIngestType hits it cheaply.
  out.push({ key: "ingest.type", value: { stringValue: "codex" } });
  // Always set codex.hook explicitly so server queries have a canonical key
  // regardless of incoming field name.
  out.push({ key: "codex.hook", value: { stringValue: event.hook_event_name } });
  for (const [k, v] of Object.entries(event)) {
    if (k === "hook_event_name") continue; // covered by codex.hook above
    const key = `codex.${k}`;
    const value = toOtlpValue(key, v);
    if (value === null) continue;
    out.push({ key, value });
  }
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
}): OtlpPayload {
  const ts = args.now ?? Date.now();
  const tsNano = (BigInt(ts) * 1_000_000n).toString();
  const span: OtlpSpan = {
    traceId: ulidToTraceId(args.traceId),
    spanId: newSpanId(),
    name: `codex.${snakeCase(args.event.hook_event_name)}`,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: tsNano,
    endTimeUnixNano: tsNano,
    attributes: flattenEvent(args.event),
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs() },
        scopeSpans: [
          {
            scope: { name: "pinta-codex", version: PLUGIN_VERSION },
            spans: [span],
          },
        ],
      },
    ],
  };
}

/**
 * Combine multiple per-hook payloads into a single OTLP payload by
 * concatenating their resourceSpans arrays. The Pinta backend's parser
 * iterates over resourceSpans natively.
 */
export function mergeBatch(payloads: OtlpPayload[]): OtlpPayload {
  const out: ResourceSpans[] = [];
  for (const p of payloads) out.push(...p.resourceSpans);
  return { resourceSpans: out };
}
