import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOtlpPayload } from "../../src/core/otlp";
import { resolveModel } from "../../src/core/model";
import type { BaseEvent } from "../../src/core/types";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const TRACE = "01HQXM7Y9YZJ8MK7Z6P3X1V8R0";
let directory: string;
let transcript: string;

beforeEach(() => {
  directory = path.resolve(".model-tests", randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  transcript = path.join(directory, "rollout.jsonl");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function write(records: unknown[]) {
  fs.writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function header(session = "session-1") {
  return { type: "session_meta", timestamp: new Date(NOW - 2_000).toISOString(), payload: { id: session } };
}

function context(model: unknown = "requested-model", turn = "turn-1", time = NOW - 1_000) {
  return { type: "turn_context", timestamp: new Date(time).toISOString(), payload: { turn_id: turn, model } };
}

function attributes(overrides: Record<string, unknown> = {}) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    transcript_path: transcript,
    turn_id: "turn-1",
    cwd: directory,
    timestamp: NOW,
    ...overrides,
  } as BaseEvent;
  return buildOtlpPayload({ event, traceId: TRACE, now: NOW })
    .resourceSpans[0].scopeSpans[0].spans[0].attributes;
}

function value(attrs: ReturnType<typeof attributes>, key: string) {
  return attrs.find((attribute) => attribute.key === `codex.${key}`)?.value;
}

describe("model evidence", () => {
  it("fills a missing model from the exact session and turn, labeling requested evidence", () => {
    write([
      { type: "session_meta", timestamp: new Date(NOW - 2_000).toISOString(), payload: { id: "session-1" } },
      { type: "turn_context", timestamp: new Date(NOW - 1_000).toISOString(), payload: { turn_id: "turn-1", model: "requested-model" } },
    ]);
    const attrs = attributes();
    expect(value(attrs, "model")).toEqual({ stringValue: "requested-model" });
    expect(value(attrs, "model_source")).toEqual({ stringValue: "transcript.turn_context" });
  });

  it("normalizes a host model descriptor to its exact ID instead of JSON", () => {
    expect(value(attributes({ model: { id: "host-model", name: "Display name" } }), "model"))
      .toEqual({ stringValue: "host-model" });
  });

  it("preserves explicit host source/provider and requested/response evidence", () => {
    const attrs = attributes({
      model: " exact-model ", model_source: "host.response", model_provider: "host-provider",
      requested_model: "requested-model", response_model: "exact-model",
    });
    expect(value(attrs, "model")).toEqual({ stringValue: "exact-model" });
    expect(value(attrs, "model_source")).toEqual({ stringValue: "host.response" });
    expect(value(attrs, "model_provider")).toEqual({ stringValue: "host-provider" });
    expect(value(attrs, "requested_model")).toEqual({ stringValue: "requested-model" });
    expect(value(attrs, "response_model")).toEqual({ stringValue: "exact-model" });
  });

  it.each(["", "  ", "unknown", "UNKNOWN", "null", "undefined", "n/a", "none"])(
    "omits the model placeholder %j",
    (model) => {
      expect(value(attributes({ model }), "model")).toBeUndefined();
    },
  );

  it("prefers explicit host evidence without model-resolver IO", () => {
    const open = vi.spyOn(fs, "openSync");
    expect(resolveModel({ hook_event_name: "PostToolUse", session_id: "session-1", cwd: directory, transcript_path: transcript, model: " host-model " }, NOW))
      .toEqual({ name: "host-model", source: "hook.model" });
    expect(open).not.toHaveBeenCalled();
  });

  it("enriches a placeholder but never overrides a valid host model", () => {
    write([header(), context()]);
    expect(value(attributes({ model: "unknown" }), "model")).toEqual({ stringValue: "requested-model" });
    expect(value(attributes({ model: "explicit-model" }), "model")).toEqual({ stringValue: "explicit-model" });
  });

  it("retains the original source when a transcript replaces unusable host model evidence", () => {
    write([header(), context()]);
    const attrs = attributes({ model: "unknown", model_source: "host.response" });
    expect(value(attrs, "model_source")).toEqual({ stringValue: "transcript.turn_context" });
    expect(value(attrs, "model_original_source")).toEqual({ stringValue: "host.response" });
  });

  it("does not take the latest turn's model for a delayed hook", () => {
    write([header(), context("earlier"), context("later", "turn-2", NOW - 500), context("future", "turn-1", NOW + 1)]);
    expect(value(attributes(), "model")).toEqual({ stringValue: "earlier" });
    expect(value(attributes({ turn_id: "turn-2" }), "model")).toEqual({ stringValue: "later" });
  });

  it("requires an exact session_meta ID and a stable turn ID", () => {
    write([header("other-session"), context()]);
    expect(value(attributes(), "model")).toBeUndefined();
    write([header(), context()]);
    expect(value(attributes({ session_id: "other-session" }), "model")).toBeUndefined();
    expect(value(attributes({ turn_id: undefined }), "model")).toBeUndefined();
    expect(value(attributes({ turn_id: "other-turn" }), "model")).toBeUndefined();
    write([header(), { type: "turn_context", timestamp: new Date(NOW - 100).toISOString(), payload: { root_turn_id: "turn-1", turn_id: "child-turn", model: "child-model" } }]);
    expect(value(attributes(), "model")).toBeUndefined();
  });

  it("does not attach parent turn context to a subagent lifecycle event", () => {
    write([header(), context("parent-model")]);
    for (const hook_event_name of ["SubagentStart", "SubagentStop"]) {
      expect(value(attributes({ hook_event_name, agent_id: "child-session" }), "model")).toBeUndefined();
      expect(value(attributes({ hook_event_name, model: "host-child-model" }), "model")).toEqual({ stringValue: "host-child-model" });
    }
    expect(value(attributes({ agent_id: "child-session" }), "model")).toBeUndefined();
  });

  it("supports a child session only through that child's own rollout and turn", () => {
    write([header("child-session"), context("child-model", "child-turn")]);
    expect(value(attributes({ session_id: "child-session", turn_id: "child-turn" }), "model")).toEqual({ stringValue: "child-model" });
    expect(value(attributes(), "model")).toBeUndefined();
  });

  it("omits conflicting and incomplete same-turn evidence instead of guessing", () => {
    write([header(), context("one"), context("two")]);
    expect(value(attributes(), "model")).toBeUndefined();
    write([header(), context("one"), context("unknown")]);
    expect(value(attributes(), "model")).toBeUndefined();
    write([header(), context("one"), context("one")]);
    expect(value(attributes(), "model")).toEqual({ stringValue: "one" });
  });

  it("does not share cached models between sessions or file rewrites", () => {
    write([header(), context("one")]);
    expect(value(attributes(), "model")).toEqual({ stringValue: "one" });
    write([header("session-2"), context("two")]);
    expect(value(attributes(), "model")).toBeUndefined();
    expect(value(attributes({ session_id: "session-2" }), "model")).toEqual({ stringValue: "two" });
  });

  it.each([
    { session_id: "../outside" }, { session_id: "" }, { turn_id: "" }, { turn_id: 123 },
    { timestamp: "invalid" }, { timestamp: NOW + 1 }, { timestamp: null },
    { transcript_path: "" }, { transcript_path: "relative.jsonl" },
  ])("omits invalid attribution metadata %j", (overrides) => {
    write([header(), context()]);
    expect(value(attributes(overrides), "model")).toBeUndefined();
  });

  it("ignores uncommitted trailing records and fails quietly on malformed complete records", () => {
    write([header(), context("one")]);
    fs.appendFileSync(transcript, JSON.stringify(context("two")));
    expect(value(attributes(), "model")).toEqual({ stringValue: "one" });
    fs.appendFileSync(transcript, "broken\n");
    expect(value(attributes(), "model")).toBeUndefined();
  });

  it("does not substitute a recent context when the requested turn is outside the bounded tail", () => {
    write([header(), context("old"), { content: "x".repeat(2 * 1024 * 1024) }, context("recent", "turn-2")]);
    expect(value(attributes(), "model")).toBeUndefined();
    expect(value(attributes({ turn_id: "turn-2" }), "model")).toEqual({ stringValue: "recent" });
  });

  it("requires a complete bounded session header rather than trusting the path", () => {
    write([{ ...header(), oversized: "x".repeat(300 * 1024) }, context()]);
    expect(value(attributes(), "model")).toBeUndefined();
  });

  it("does not infer model IDs from provider config, CLI version or user prose", () => {
    vi.stubEnv("CODEX_MODEL", "global-default");
    write([header(), { type: "response_item", payload: { role: "user", content: "use prose-model" } }]);
    expect(value(attributes({ cli_version: "1.2.3", model_provider: "vendor", prompt: "use prose-model" }), "model")).toBeUndefined();
  });

  it("leaves raw input unchanged, keeps one span and preserves redaction", () => {
    const secret = "sk-" + "a".repeat(48);
    const event: BaseEvent = Object.freeze({ hook_event_name: "PostToolUse", session_id: "s", cwd: directory, transcript_path: transcript, model: Object.freeze({ id: "host-model" }), tool_input: Object.freeze({ api_key: secret }) });
    const payload = buildOtlpPayload({ event, traceId: TRACE, now: NOW });
    expect(event.model).toEqual({ id: "host-model" });
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(value(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes, "model")).toEqual({ stringValue: "host-model" });
  });
});
