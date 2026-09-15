// --- Codex hook event types ---
//
// Codex fires PascalCase event names that overlap Claude Code's hook contract
// but are NOT a subset of it. The authoritative list is `HOOK_EVENT_NAMES` in
// `codex-rs/hooks/src/lib.rs`; the same twelve names are readable straight out
// of the shipped binary's embedded JSON schemas, one `<event>.command.input`
// per event (verified against codex-cli 0.154.0).
//
// PreToolUse is NOT Bash-only. It was widened to `apply_patch` and MCP tools in
// v0.123.0 (openai/codex#18385, #18391) and to every local function tool by
// default in v0.134.0 (#23757); only `write_stdin` and code-mode `wait` opt
// out, and the hosted `web_search` never reaches local dispatch at all. Pinta's
// hooks carry no `matcher`, and an absent matcher matches everything, so this
// adaptor already receives `apply_patch` and MCP payloads today.

export interface BaseEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  turn_id?: string;
  model?: string;
  // Other hook-specific fields are accessed via flattening; we don't enumerate them.
  [key: string]: unknown;
}

export interface PreToolUseEvent extends BaseEvent {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/**
 * Codex's approval gate, and a second chokepoint rather than a copy of the
 * first.
 *
 * It carries the same `tool_name` + `tool_input` shape as PreToolUse, so the
 * guard is asked the same question. What differs is the reach, in both
 * directions, and neither substitutes for the other:
 *
 *   - It sees `NetworkAccess`, which has no PreToolUse counterpart at all.
 *     Approval variants are enumerated in `codex-rs/core/src/tools/approvals.rs`
 *     (ExecCommand, WriteStdin, Execve, ApplyPatch, McpToolCall, NetworkAccess,
 *     RequestPermissions).
 *   - It only fires when an approval is actually requested. `--full-auto`,
 *     `--dangerously-bypass-approvals-and-sandbox`, `approval_policy = "never"`
 *     and sandbox-permitted commands never call `request_approval`, so this
 *     event is silent exactly where the risk of unattended execution is highest.
 *
 * That asymmetry is why PreToolUse stays the primary gate: it is dispatched
 * from the tool-dispatch path regardless of approval policy. This one adds the
 * axis PreToolUse cannot reach, and outranks both Guardian and the user when it
 * does fire (`approvals.rs` documents the precedence as hooks first).
 *
 * `permission_mode` is unique to this event and is worth forwarding: it records
 * which policy was in force, which is what distinguishes "the user was asked"
 * from "nothing would have asked".
 */
export interface PermissionRequestEvent extends BaseEvent {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_mode?:
    | "default"
    | "acceptEdits"
    | "plan"
    | "dontAsk"
    | "bypassPermissions"
    | string;
}

export interface PostToolUseEvent extends BaseEvent {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id: string;
}

export interface UserPromptSubmitEvent extends BaseEvent {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface SessionEvent extends BaseEvent {
  hook_event_name: "SessionStart";
  source?: "startup" | "resume" | string;
}

export interface StopEvent extends BaseEvent {
  hook_event_name: "Stop";
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

// --- Observe-only lifecycle events ---
//
// These carry no tool and cannot refuse anything. `SessionEnd` is the clearest
// case: the binary ships a `session-end.command.input` schema and no
// `session-end.command.output`, so codex does not read a reply from it at all.
// The rest accept an output envelope, but none of it can stop a tool call.

export interface PreCompactEvent extends BaseEvent {
  hook_event_name: "PreCompact";
  trigger?: "manual" | "auto" | string;
}

export interface PostCompactEvent extends BaseEvent {
  hook_event_name: "PostCompact";
  trigger?: "manual" | "auto" | string;
}

export interface SessionEndEvent extends BaseEvent {
  hook_event_name: "SessionEnd";
  reason?: string;
}

export interface SubagentStartEvent extends BaseEvent {
  hook_event_name: "SubagentStart";
  agent_id?: string;
  agent_type?: string;
}

export interface SubagentStopEvent extends BaseEvent {
  hook_event_name: "SubagentStop";
  agent_id?: string;
  agent_type?: string;
}

export interface InterruptEvent extends BaseEvent {
  hook_event_name: "Interrupt";
}

// --- Type guards ---

export function isPreToolUseEvent(event: BaseEvent): event is PreToolUseEvent {
  return event.hook_event_name === "PreToolUse";
}

export function isPermissionRequestEvent(event: BaseEvent): event is PermissionRequestEvent {
  return event.hook_event_name === "PermissionRequest";
}

export function isPostToolUseEvent(event: BaseEvent): event is PostToolUseEvent {
  return event.hook_event_name === "PostToolUse";
}

export function isUserPromptSubmitEvent(event: BaseEvent): event is UserPromptSubmitEvent {
  return event.hook_event_name === "UserPromptSubmit";
}

export function isSessionEvent(event: BaseEvent): event is SessionEvent {
  return event.hook_event_name === "SessionStart";
}

export function isStopEvent(event: BaseEvent): event is StopEvent {
  return event.hook_event_name === "Stop";
}

// --- Event inventory ---
//
// Split by what a handler is ALLOWED to do with the event, not by how much of
// it we happen to parse. The two gates below are the only events whose reply
// can stop a tool from running; everything else is telemetry no matter how
// rich its payload is. Keeping that distinction in the data — rather than
// implied by which handler a name happens to route to — is what stops a future
// event from being wired to a blocking handler whose reply codex never reads.

/** Events whose stdout can refuse a tool call. */
export const BLOCKING_HOOKS = ["PreToolUse", "PermissionRequest"] as const;

/** Events that carry no refusal. Forwarded as telemetry only. */
export const OBSERVE_HOOKS = [
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
] as const;

/**
 * Every event codex 0.154.0 dispatches — `HOOK_EVENT_NAMES` in
 * `codex-rs/hooks/src/lib.rs`, cross-checked against the twelve
 * `<event>.command.input` schemas embedded in the shipped binary.
 *
 * An event absent from this set reaches the default handler and exits 0, so a
 * codex release that adds a thirteenth stays fail-open rather than erroring.
 */
const KNOWN_HOOKS = new Set<string>([...BLOCKING_HOOKS, ...OBSERVE_HOOKS]);

export function isSkippedHook(event: BaseEvent): boolean {
  return !KNOWN_HOOKS.has(event.hook_event_name);
}

// --- Hook output types ---
//
// The two gates do NOT share an output shape, and the difference fails
// silently rather than loudly: codex parses each event's reply against its own
// schema, and a well-formed envelope for the wrong event carries no decision at
// all. Both shapes below are transcribed from the binary's embedded
// `<event>.command.output` schemas.

/**
 * PreToolUse: a flat `permissionDecision` + `permissionDecisionReason`.
 *
 * `deny` is the only value that does anything. The dispatcher rejects
 * `permissionDecision:allow` and `permissionDecision:ask` as unsupported, so
 * this type deliberately cannot express them — an ALLOW is an empty stdout.
 *
 * `permissionDecisionReason` must be non-empty or codex discards the block
 * ("PreToolUse hook returned permissionDecision:deny without a non-empty
 * permissionDecisionReason"). That invariant is load-bearing, not cosmetic.
 */
export interface HookBlockOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * PermissionRequest: a NESTED `decision: { behavior, message }`.
 *
 * Not a cosmetic difference. Sending PreToolUse's flat shape here parses as a
 * valid envelope with no decision in it, and the deny is dropped without a
 * diagnostic. `behavior` is the only required field; `message` is filled
 * unconditionally for the same reason `permissionDecisionReason` is — a blocked
 * action that cannot say why is indistinguishable from a malfunction.
 *
 * `updatedInput`, `updatedPermissions` and `interrupt: true` are reserved, and
 * the dispatcher fails closed on all three, so they must never be emitted.
 */
export interface PermissionRequestBlockOutput {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "deny";
      message: string;
    };
  };
}
