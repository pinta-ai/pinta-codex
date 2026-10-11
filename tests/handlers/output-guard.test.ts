import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTICE, type OtlpPayload } from "@pinta-ai/core";
import type { PintaCodexConfig } from "../../src/core/config.js";
import type { GuardResult } from "../../src/core/guard.js";
import type { PostToolUseEvent } from "../../src/core/types.js";

vi.mock("../../src/handlers/emit.js", async (original) => ({
  ...await original<typeof import("../../src/handlers/emit.js")>(),
  sendPayload: vi.fn(),
  deferPayload: vi.fn(),
}));
vi.mock("../../src/core/trace.js", () => ({
  TraceManager: class { currentTrace() { return "1".repeat(26); } },
}));
vi.mock("../../src/core/guard.js", () => ({ evaluateGuard: vi.fn() }));

import { evaluateGuard } from "../../src/core/guard.js";
import { deferPayload, sendPayload } from "../../src/handlers/emit.js";
import { handlePostToolUse } from "../../src/handlers/post-tool-use.js";
import { handlePreToolUse } from "../../src/handlers/pre-tool-use.js";
import { handlePermissionRequest } from "../../src/handlers/permission-request.js";

/**
 * What the output gate puts on stdout (PTA-695).
 *
 * Codex reads one `{"decision":"block","reason"}` line and substitutes `reason`
 * for the tool result, so `reason` carries the whole substitute: the policy's
 * message, the recovery hint and — when the manager sent the detected values —
 * the output with those values masked. These tests pin that envelope, that the
 * detected value never reaches stdout or the span's `pinta.guard.*` attributes,
 * and that an old manager (no `outputAction`) still produces a usable withhold.
 */

const config = {} as PintaCodexConfig;
// A neutral token standing in for a detected credential. Not a real key shape.
const SENSITIVE = "ctx7sk-FAKE0000";
const USER_MESSAGE = "Blocked by Pinta AI: a credential appeared in this tool output.";
const event: PostToolUseEvent = {
  hook_event_name: "PostToolUse", session_id: "audit", transcript_path: "",
  cwd: process.cwd(), tool_name: "Bash", tool_input: { command: "printf audit" },
  tool_use_id: "call-audit", tool_response: { stdout: `token ${SENSITIVE} ok`, exit_code: 0 },
};
/** What a manager older than 0.1.16 sends: decision + rule id + message, nothing about delivery. */
const oldDeny: GuardResult = { decision: "DENY", reason: "output-policy", userMessage: USER_MESSAGE, durationMs: 1 };
/** What a 0.1.16+ manager sends when every signal the rule read carried a value. */
const maskDeny: GuardResult = {
  ...oldDeny,
  evaluationId: "ev-1",
  outputAction: "mask",
  redactions: [{ category: "CREDENTIAL", match: SENSITIVE }],
};
const attributes = (payload: OtlpPayload) => Object.fromEntries(
  payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map(a => [a.key, a.value]),
);
const askedAbout = () => vi.mocked(evaluateGuard).mock.calls[0][0] as OtlpPayload;

let output: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sole = () => {
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]) as { decision: string; reason: string };
};

describe("PostToolUse mask — the output is delivered with the detected values replaced", () => {
  it("answers one block line whose reason is notice, guidance, then the masked output", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue(maskDeny);
    await handlePostToolUse(event, config);
    const out = sole();
    expect(Object.keys(out).sort()).toEqual(["decision", "reason"]);
    expect(out.decision).toBe("block");

    const [notice, guidance, masked] = out.reason.split("\n\n");
    expect(notice).toBe(`${USER_MESSAGE} (evaluation ev-1)`);
    expect(guidance).toContain("Pinta masked 1 detected value(s)");
    expect(guidance).toContain("evaluation ev-1");
    // The masked part is the same JSON the span carries, still parseable, with
    // only the detected value replaced.
    expect(JSON.parse(masked)).toEqual({ stdout: "token [REDACTED:CREDENTIAL] ok", exit_code: 0 });
    expect(output.join("")).not.toContain(SENSITIVE);
  });

  it("masks a string tool_response as-is", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue(maskDeny);
    await handlePostToolUse({ ...event, tool_response: `token ${SENSITIVE} ok` }, config);
    const { reason } = sole();
    expect(reason.endsWith("\n\ntoken [REDACTED:CREDENTIAL] ok")).toBe(true);
    expect(reason).not.toContain(SENSITIVE);
  });

  it("falls back to withhold when the value the manager named is not in the output", async () => {
    // Delivering the output would deliver exactly what the policy denied.
    vi.mocked(evaluateGuard).mockResolvedValue({ ...maskDeny, redactions: [{ category: "CREDENTIAL", match: "not-in-output" }] });
    await handlePostToolUse(event, config);
    const { reason } = sole();
    expect(reason).toContain("Pinta withheld this tool output");
    expect(reason).not.toContain(SENSITIVE);
    expect(reason).not.toContain("token ");
  });

  it("never emits the keys that end or alter the run", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue(maskDeny);
    await handlePostToolUse(event, config);
    const out = sole();
    // continue:false stops the turn; updatedMCPToolOutput is unsupported by
    // codex 0.154.0 and makes it ignore the hook (fail-open).
    for (const forbidden of ["continue", "stopReason", "suppressOutput", "hookSpecificOutput", "updatedMCPToolOutput"]) {
      expect(out).not.toHaveProperty(forbidden);
    }
  });
});

describe("PostToolUse withhold — nothing of the output is delivered", () => {
  it.each([
    ["an old manager that sends no outputAction", oldDeny],
    ["an explicit withhold", { ...oldDeny, evaluationId: "ev-2", outputAction: "withhold" as const }],
  ])("%s yields the policy message plus the withhold guidance", async (_label, guard) => {
    vi.mocked(evaluateGuard).mockResolvedValue(guard);
    await handlePostToolUse(event, config);
    const out = sole();
    expect(out.decision).toBe("block");
    const parts = out.reason.split("\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain(USER_MESSAGE);
    expect(parts[1]).toContain("Pinta withheld this tool output because its content matched a blocking policy");
    expect(out.reason).not.toContain(SENSITIVE);
    expect(out.reason).not.toContain("token ");
    expect(out.reason).not.toContain("[REDACTED");
    expect(out).not.toHaveProperty("continue");
  });

  it("names the evaluation when the manager sent an id, and says so when it did not", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue({ ...oldDeny, evaluationId: "ev-2" });
    await handlePostToolUse(event, config);
    expect(sole().reason).toContain("(evaluation ev-2)");
    expect(output[0]).toContain("report evaluation ev-2");

    output = [];
    vi.mocked(evaluateGuard).mockResolvedValue(oldDeny);
    await handlePostToolUse(event, config);
    expect(sole().reason).not.toContain("(evaluation");
    expect(output[0]).toContain("id unavailable");
  });

  it("uses the shared default notice when the manager sent no userMessage", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue({ ...oldDeny, userMessage: null });
    await handlePostToolUse(event, config);
    expect(sole().reason.startsWith(DEFAULT_NOTICE)).toBe(true);
  });

  it.each([
    "audit result",
    { stdout: "audit result", exit_code: 0 },
    { stderr: "audit result", exit_code: 1 },
    { content: [{ type: "text", text: "audit result" }], isError: true },
  ])("judges supplied output and emits only the native post-tool contract", async (response) => {
    vi.mocked(evaluateGuard).mockResolvedValue(oldDeny);
    await handlePostToolUse({ ...event, tool_response: response }, config);
    const out = sole();
    expect(Object.keys(out).sort()).toEqual(["decision", "reason"]);
    expect(out.reason).not.toContain("audit result");
    expect(sendPayload).not.toHaveBeenCalled();
    const payload = askedAbout();
    expect(deferPayload).toHaveBeenCalledWith(payload, config);
    expect(attributes(payload)).toMatchObject({
      "codex.hook": { stringValue: "PostToolUse" },
      "codex.tool_use_id": { stringValue: "call-audit" },
      "codex.tool_response": { stringValue: typeof response === "string" ? response : JSON.stringify(response) },
      "pinta.guard.decision": { stringValue: "deny" },
      "pinta.guard.target": { stringValue: "tool_output" },
    });
  });
});

describe("PostToolUse telemetry on DENY", () => {
  it("writes the block before persistence and never awaits the collector", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue(maskDeny);
    vi.mocked(deferPayload).mockImplementation(() => {
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]).decision).toBe("block");
    });
    await expect(handlePostToolUse(event, config)).resolves.toBe(0);
    expect(deferPayload).toHaveBeenCalledOnce();
    expect(sendPayload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the detected values out of the span: pinta.guard.* never carries redactions", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue(maskDeny);
    await handlePostToolUse(event, config);
    const attrs = attributes(askedAbout());
    // No attribute names the new fields (`matched_rule` is the rule id, not a match).
    expect(Object.keys(attrs).filter(k => /redaction|\.match$|output_?action/i.test(k))).toEqual([]);
    for (const [key, value] of Object.entries(attrs)) {
      if (!key.startsWith("pinta.guard.")) continue;
      expect(JSON.stringify(value), key).not.toContain(SENSITIVE);
    }
    expect(attrs["pinta.guard.decision"]).toEqual({ stringValue: "deny" });
    expect(attrs["pinta.guard.matched_rule"]).toEqual({ stringValue: "output-policy" });
    expect(attrs["pinta.guard.target"]).toEqual({ stringValue: "tool_output" });
  });

  it("queues the same span for a mask DENY as for an old-manager DENY", async () => {
    // The new response fields change what the model gets, not what is stored.
    vi.mocked(evaluateGuard).mockResolvedValue(maskDeny);
    await handlePostToolUse(event, config);
    const masked = attributes(askedAbout());
    vi.mocked(evaluateGuard).mockClear();
    vi.mocked(evaluateGuard).mockResolvedValue(oldDeny);
    await handlePostToolUse(event, config);
    const withheld = attributes(askedAbout());
    expect(masked).toEqual(withheld);
  });

  it("does not reflect the rule id into model-facing output", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue({ ...oldDeny, reason: "UNTRUSTED_OUTPUT_MARKER" });
    await handlePostToolUse(event, config);
    expect(output.join("")).not.toContain("UNTRUSTED_OUTPUT_MARKER");
    expect(attributes(askedAbout())["pinta.guard.matched_rule"]).toEqual({ stringValue: "UNTRUSTED_OUTPUT_MARKER" });
  });

  it("supplies non-empty feedback and preserves it if enqueue fails", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue({ ...oldDeny, reason: " ", userMessage: null });
    vi.mocked(deferPayload).mockImplementation(() => { throw new Error("queue unavailable"); });
    await expect(handlePostToolUse(event, config)).resolves.toBe(0);
    const out = sole();
    expect(out.decision).toBe("block");
    expect(out.reason.trim().length).toBeGreaterThan(0);
  });
});

describe("PostToolUse on anything but DENY", () => {
  it.each(["ALLOW", "REVIEW", null])("preserves %s and ordinary telemetry", async (decision) => {
    vi.mocked(evaluateGuard).mockResolvedValue(decision ? { ...oldDeny, decision } as never : null);
    await handlePostToolUse(event, config);
    expect(output).toEqual([]);
    expect(sendPayload).toHaveBeenCalledOnce();
    expect(deferPayload).not.toHaveBeenCalled();
  });
});

describe("decided DENY has no collector dependency", () => {
  it.each(["PreToolUse", "PermissionRequest", "PostToolUse"] as const)("%s completes with an unresolved collector", async (hook) => {
    vi.mocked(evaluateGuard).mockResolvedValue(oldDeny);
    vi.mocked(sendPayload).mockImplementation(() => new Promise(() => {}));
    const handler = { PreToolUse: handlePreToolUse, PermissionRequest: handlePermissionRequest, PostToolUse: handlePostToolUse }[hook];
    const { tool_response, ...beforeEvent } = event;
    const input = hook === "PostToolUse" ? event : { ...beforeEvent, hook_event_name: hook };
    await expect(handler(input as never, config)).resolves.toBe(0);
    expect(sendPayload).not.toHaveBeenCalled();
    expect(deferPayload).toHaveBeenCalledOnce();
    expect(output).toHaveLength(1);
  });
});
