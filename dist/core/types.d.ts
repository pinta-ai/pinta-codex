export interface BaseEvent {
    session_id: string;
    transcript_path: string;
    cwd: string;
    hook_event_name: string;
    turn_id?: string;
    model?: string;
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
export declare function isPreToolUseEvent(event: BaseEvent): event is PreToolUseEvent;
export declare function isPostToolUseEvent(event: BaseEvent): event is PostToolUseEvent;
export declare function isUserPromptSubmitEvent(event: BaseEvent): event is UserPromptSubmitEvent;
export declare function isSessionEvent(event: BaseEvent): event is SessionEvent;
export declare function isStopEvent(event: BaseEvent): event is StopEvent;
export declare function isSkippedHook(event: BaseEvent): boolean;
export interface HookBlockOutput {
    hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
    };
}
