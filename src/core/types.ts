// --- Codex hook event types ---
//
// Codex fires PascalCase event names identical to Claude Code's hook contract:
// SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop.
// PreToolUse / PostToolUse currently fire only for the Bash tool.

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

// --- Type guards ---

export function isPreToolUseEvent(event: BaseEvent): event is PreToolUseEvent {
  return event.hook_event_name === "PreToolUse";
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

// --- Skip-list (route to default no-op handler) ---
//
// Codex's current hook surface is limited to the five events above. Any other
// hook name reaches the default handler and exits 0 so unknown/future hooks
// stay fail-open.

const KNOWN_HOOKS = new Set<string>([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
]);
export function isSkippedHook(event: BaseEvent): boolean {
  return !KNOWN_HOOKS.has(event.hook_event_name);
}

// --- Hook output types ---

export interface HookBlockOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}
