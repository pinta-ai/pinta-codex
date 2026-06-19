"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePreToolUse = handlePreToolUse;
const guard_js_1 = require("../core/guard.js");
const emit_js_1 = require("./emit.js");
async function handlePreToolUse(event, config) {
    // codex CLI doesn't inject pinta-codex.env into hook env; config.guardEndpoint
    // already merges process.env + envFile fallback (1.2.4).
    const rawToolInput = typeof event.tool_input === "string"
        ? event.tool_input
        : JSON.stringify(event.tool_input);
    const guard = await (0, guard_js_1.evaluateGuard)({
        spanId: event.session_id ?? "unknown",
        toolName: event.tool_name,
        toolInput: event.tool_input,
        rawTextFields: { toolInput: rawToolInput },
    }, config.guardEndpoint);
    await (0, emit_js_1.emitEvent)(event, config, { trace: "current", guard });
    if (guard?.decision === "DENY") {
        const out = {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: guard.reason ?? "guard_deny",
            },
        };
        process.stdout.write(JSON.stringify(out) + "\n");
    }
    return 0;
}
//# sourceMappingURL=pre-tool-use.js.map