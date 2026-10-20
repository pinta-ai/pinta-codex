import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModel } from "../../src/core/model";
import type { BaseEvent } from "../../src/core/types";

/**
 * Rollout files as Codex writes them (openai/codex `codex-rs`: `RolloutLine` =
 * { timestamp, type, payload }, `SessionMeta`, `TurnContextItem`, response and
 * event records). The records below carry the real field names and, for the
 * bulky ones (encrypted reasoning, command output), a realistic size, because
 * what broke the lookup in practice is the volume that follows a turn's
 * `turn_context`, not its shape.
 */
const NOW = Date.parse("2026-10-19T12:00:00Z");
const SESSION = "0199d4f2-7c1a-7e3b-9a52-3f1d2c8b6a10";
const TURN = "0199d4f3-0b6e-7a41-8c7d-5e2f9a1b3c44";
let directory: string;
let file: string;

beforeEach(() => {
  directory = path.resolve(".model-tests", randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  file = path.join(directory, `rollout-2026-10-19T11-00-00-${SESSION}.jsonl`);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

let tick = 0;
function line(type: string, payload: unknown): string {
  const at = new Date(NOW - 3_600_000 + (tick += 7)).toISOString();
  return JSON.stringify({ timestamp: at, type, payload });
}

function sessionMeta(id = SESSION, sessionId = id): string {
  return line("session_meta", {
    id, session_id: sessionId, timestamp: new Date(NOW - 3_600_000).toISOString(),
    cwd: "/work/repo", originator: "codex_cli_rs", cli_version: "0.9.9", source: "cli",
    model_provider: "openai", base_instructions: { text: "You are Codex. ".repeat(900) },
    git: { commit_hash: "0123456789abcdef", branch: "main" },
  });
}

function turnContext(model: string, turn = TURN): string {
  return line("turn_context", {
    turn_id: turn, cwd: "/work/repo", approval_policy: "on-request",
    sandbox_policy: { type: "workspace-write" }, model, effort: "medium", summary: "none",
  });
}

/** One agent step: reasoning, a command, its output, and a token count. */
function step(index: number, outputBytes: number): string[] {
  const call = `call_${index}`;
  return [
    line("response_item", { type: "reasoning", summary: [], encrypted_content: "gAAAA".padEnd(6_000, "x") }),
    line("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls"] }), call_id: call }),
    line("event_msg", { type: "exec_command_begin", call_id: call, turn_id: TURN }),
    line("event_msg", { type: "exec_command_end", call_id: call, turn_id: TURN, aggregated_output: "o".repeat(outputBytes) }),
    line("response_item", { type: "function_call_output", call_id: call, output: "o".repeat(outputBytes) }),
    line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: index } } }),
  ];
}

function write(lines: string[]) {
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

function model(overrides: Record<string, unknown> = {}) {
  const event = {
    hook_event_name: "PreToolUse", session_id: SESSION, turn_id: TURN, transcript_path: file,
    cwd: "/work/repo", tool_name: "shell", tool_use_id: "call_1", ...overrides,
  } as BaseEvent;
  return resolveModel(event, NOW);
}

describe("model from a real-shaped Codex rollout", () => {
  it("reads the turn's model right after the turn starts", () => {
    write([sessionMeta(), turnContext("gpt-5-codex"), ...step(1, 2_000)]);
    expect(model()).toEqual({ name: "gpt-5-codex", source: "transcript.turn_context" });
  });

  it("still finds it late in a long agentic turn (megabytes of tool output after turn_context)", () => {
    const lines = [sessionMeta(), turnContext("gpt-5-codex")];
    for (let i = 1; i <= 150; i++) lines.push(...step(i, 20_000));
    write(lines);
    expect(fs.statSync(file).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(model()).toEqual({ name: "gpt-5-codex", source: "transcript.turn_context" });
  });

  it("still finds it after thousands of small records", () => {
    const lines = [sessionMeta(), turnContext("gpt-5-codex")];
    for (let i = 1; i <= 800; i++) lines.push(...step(i, 10));
    write(lines);
    expect(lines.length).toBeGreaterThan(4_800);
    expect(model()).toEqual({ name: "gpt-5-codex", source: "transcript.turn_context" });
  });

  it("works in a forked thread whose file carries the parent's session_meta and turn contexts", () => {
    const parent = "0199d4e0-1111-7222-8333-944455556666";
    write([
      sessionMeta(),
      sessionMeta(parent), turnContext("parent-model", "0199d4e0-aaaa-7bbb-8ccc-9dddeeeeffff"), ...step(1, 500),
      turnContext("gpt-5-codex"), ...step(2, 500),
    ]);
    expect(model()).toEqual({ name: "gpt-5-codex", source: "transcript.turn_context" });
  });

  it("uses each turn's own model in a resumed session, even for a delayed hook", () => {
    const earlier = "0199d4f2-0000-7000-8000-000000000001";
    write([sessionMeta(), turnContext("model-a", earlier), ...step(1, 500), turnContext("model-b"), ...step(2, 500)]);
    expect(model({ turn_id: earlier })?.name).toBe("model-a");
    expect(model()?.name).toBe("model-b");
  });

  it("steps over a single record far larger than a read chunk without re-copying it", () => {
    const huge = line("response_item", { type: "function_call_output", call_id: "c", output: "o".repeat(11 * 1024 * 1024) });
    write([sessionMeta(), turnContext("gpt-5-codex"), ...step(1, 500), huge, ...step(2, 500)]);
    const concat = vi.spyOn(Buffer, "concat");
    expect(model()).toEqual({ name: "gpt-5-codex", source: "transcript.turn_context" });
    const copied = concat.mock.calls.reduce((sum, [list]) => sum + list.reduce((n, part) => n + part.length, 0), 0);
    expect(copied).toBeLessThan(8 * 1024 * 1024); // growing a carry across 11 chunks would copy ~66 MiB
    // A huge half-written last record is not committed and is not copied around either.
    fs.appendFileSync(file, "x".repeat(3 * 1024 * 1024));
    concat.mockClear();
    expect(model()).toEqual({ name: "gpt-5-codex", source: "transcript.turn_context" });
    expect(concat.mock.calls.reduce((sum, [list]) => sum + list.reduce((n, part) => n + part.length, 0), 0)).toBeLessThan(8 * 1024 * 1024);
    concat.mockRestore();
  });

  it("fixes the result when an earlier turn's context sits between two contexts of this turn", () => {
    const earlier = "0199d4f2-0000-7000-8000-000000000001";
    // Scanning back: this turn's last context is seen, then the earlier turn's ends the scan.
    // Contexts of one turn are written together, so an earlier turn between them is not
    // expected; if it ever happens the older context is not read and the result is the
    // newest one alone, never a model from the other turn.
    write([sessionMeta(), turnContext("model-a"), turnContext("model-x", earlier), turnContext("model-a"), ...step(1, 500)]);
    expect(model()).toEqual({ name: "model-a", source: "transcript.turn_context" });
    write([sessionMeta(), turnContext("model-b"), turnContext("model-x", earlier), turnContext("model-a"), ...step(1, 500)]);
    expect(model()?.name).toBe("model-a");
  });

  it("accepts the same model recorded again in the same turn", () => {
    write([sessionMeta(), turnContext("gpt-5-codex"), ...step(1, 500), turnContext("gpt-5-codex"), ...step(2, 500)]);
    expect(model()?.name).toBe("gpt-5-codex");
  });

  it("stays empty when the turn recorded two different models, even far apart", () => {
    const lines = [sessionMeta(), turnContext("model-a")];
    for (let i = 1; i <= 100; i++) lines.push(...step(i, 20_000));
    lines.push(turnContext("model-b"), ...step(101, 500));
    write(lines);
    expect(model()).toBeUndefined();
  });

  it("stays empty for another session's file and for a turn that is not in it", () => {
    write([sessionMeta("0199d4f2-ffff-7000-8000-00000000abcd"), turnContext("gpt-5-codex")]);
    expect(model()).toBeUndefined();
    write([sessionMeta(), turnContext("gpt-5-codex", "0199d4f3-9999-7000-8000-000000000009"), ...step(1, 500)]);
    expect(model()).toBeUndefined();
  });

  it("gives up rather than scanning an unbounded file for a turn that is far behind", () => {
    const lines = [sessionMeta(), turnContext("gpt-5-codex")];
    const bulk = step(1, 200_000);
    for (let i = 0; i < 100; i++) lines.push(...bulk);
    write(lines);
    expect(fs.statSync(file).size).toBeGreaterThan(20 * 1024 * 1024);
    expect(model()).toBeUndefined();
  });
});
