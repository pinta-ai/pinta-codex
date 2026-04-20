"use strict";
// --- Codex hook event types ---
//
// Codex fires PascalCase event names identical to Claude Code's hook contract:
// SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop.
// PreToolUse / PostToolUse currently fire only for the Bash tool.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPreToolUseEvent = isPreToolUseEvent;
exports.isPostToolUseEvent = isPostToolUseEvent;
exports.isUserPromptSubmitEvent = isUserPromptSubmitEvent;
exports.isSessionEvent = isSessionEvent;
exports.isStopEvent = isStopEvent;
exports.isSkippedHook = isSkippedHook;
// --- Type guards ---
function isPreToolUseEvent(event) {
    return event.hook_event_name === "PreToolUse";
}
function isPostToolUseEvent(event) {
    return event.hook_event_name === "PostToolUse";
}
function isUserPromptSubmitEvent(event) {
    return event.hook_event_name === "UserPromptSubmit";
}
function isSessionEvent(event) {
    return event.hook_event_name === "SessionStart";
}
function isStopEvent(event) {
    return event.hook_event_name === "Stop";
}
// --- Skip-list (route to default no-op handler) ---
//
// Codex's current hook surface is limited to the five events above. Any other
// hook name reaches the default handler and exits 0 so unknown/future hooks
// stay fail-open.
const KNOWN_HOOKS = new Set([
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
]);
function isSkippedHook(event) {
    return !KNOWN_HOOKS.has(event.hook_event_name);
}
//# sourceMappingURL=types.js.map