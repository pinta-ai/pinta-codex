import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OtlpPayload } from "@pinta-ai/core";
import type { PintaCodexConfig } from "../../src/core/config.js";
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
import { handlePostToolUse, OUTPUT_DENIAL_REASON } from "../../src/handlers/post-tool-use.js";
import { handlePreToolUse } from "../../src/handlers/pre-tool-use.js";
import { handlePermissionRequest } from "../../src/handlers/permission-request.js";

const config = {} as PintaCodexConfig;
const event: PostToolUseEvent = {
  hook_event_name: "PostToolUse", session_id: "audit", transcript_path: "",
  cwd: process.cwd(), tool_name: "Bash", tool_input: { command: "printf audit" },
  tool_use_id: "call-audit", tool_response: { stdout: "audit result", exit_code: 0 },
};
const deny = { decision: "DENY" as const, reason: "output-policy", durationMs: 1 };
const attributes = (payload: OtlpPayload) => Object.fromEntries(
  payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map(a => [a.key, a.value]),
);

let output: string[];
beforeEach(() => {
  vi.resetAllMocks();
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("PostToolUse handler (native dispatch verified separately)", () => {
  it.each([
    "audit result",
    { stdout: "audit result", exit_code: 0 },
    { stderr: "audit result", exit_code: 1 },
    { content: [{ type: "text", text: "audit result" }], isError: true },
  ])("judges supplied output and emits only the native post-tool contract", async (response) => {
    vi.mocked(evaluateGuard).mockResolvedValue(deny);
    await handlePostToolUse({ ...event, tool_response: response }, config);
    expect(output.map(line => JSON.parse(line))).toEqual([{ decision: "block", reason: OUTPUT_DENIAL_REASON }]);
    expect(sendPayload).not.toHaveBeenCalled();
    const payload = vi.mocked(evaluateGuard).mock.calls[0][0] as OtlpPayload;
    expect(deferPayload).toHaveBeenCalledWith(payload, config);
    expect(attributes(payload)).toMatchObject({
      "codex.hook": { stringValue: "PostToolUse" },
      "codex.tool_use_id": { stringValue: "call-audit" },
      "codex.tool_response": { stringValue: typeof response === "string" ? response : JSON.stringify(response) },
      "pinta.guard.decision": { stringValue: "deny" },
      "pinta.guard.target": { stringValue: "tool_output" },
    });
  });

  it.each(["ALLOW", "REVIEW", null])("preserves %s and ordinary telemetry", async (decision) => {
    vi.mocked(evaluateGuard).mockResolvedValue(decision ? { ...deny, decision } as never : null);
    await handlePostToolUse(event, config);
    expect(output).toEqual([]);
    expect(sendPayload).toHaveBeenCalledOnce();
    expect(deferPayload).not.toHaveBeenCalled();
  });

  it("supplies non-empty feedback and preserves it if enqueue fails", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue({ ...deny, reason: " " });
    vi.mocked(deferPayload).mockImplementation(() => { throw new Error("queue unavailable"); });
    await expect(handlePostToolUse(event, config)).resolves.toBe(0);
    expect(JSON.parse(output[0])).toEqual({ decision: "block", reason: OUTPUT_DENIAL_REASON });
  });

  it("writes fixed feedback before persistence without reflecting guard-supplied output", async () => {
    vi.mocked(evaluateGuard).mockResolvedValue({ ...deny, reason: "UNTRUSTED_OUTPUT_MARKER" });
    vi.mocked(deferPayload).mockImplementation(() => {
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]).reason).toBe(OUTPUT_DENIAL_REASON);
    });
    await handlePostToolUse(event, config);
    expect(output.join("")).not.toContain("UNTRUSTED_OUTPUT_MARKER");
    const payload = vi.mocked(evaluateGuard).mock.calls[0][0] as OtlpPayload;
    expect(attributes(payload)["pinta.guard.matched_rule"]).toEqual({ stringValue: "UNTRUSTED_OUTPUT_MARKER" });
  });
});

describe("decided DENY has no collector dependency", () => {
  it.each(["PreToolUse", "PermissionRequest", "PostToolUse"] as const)("%s completes with an unresolved collector", async (hook) => {
    vi.mocked(evaluateGuard).mockResolvedValue(deny);
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
