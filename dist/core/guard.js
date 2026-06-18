"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateGuard = evaluateGuard;
// codex-specific binding over the shared guard in @pinta-ai/core. Preserves the
// historical codex behavior: a SHORT 50ms timeout, relay token + disable flag
// read from process.env, a `pinta-codex/<version>` User-Agent, and a result
// shape that does NOT carry the manager's `userMessage` field (codex has never
// surfaced it). We map core's richer result down to codex's historical shape.
const core_1 = require("@pinta-ai/core");
const TIMEOUT_MS = 50;
// Self-identify to the manager's guard route so it can attribute calls to this
// adaptor (the route parses `pinta-*/<version>` out of the User-Agent). Keep the
// version in sync with package.json.
const GUARD_UA = 'pinta-codex/1.3.1';
async function evaluateGuard(input, endpoint) {
    const result = await (0, core_1.evaluateGuard)(input, endpoint, {
        timeoutMs: TIMEOUT_MS,
        token: process.env.PINTA_RELAY_TOKEN ?? '',
        disabled: process.env.PINTA_GUARD_DISABLED === '1',
        userAgent: GUARD_UA,
    });
    if (result === null)
        return null;
    // Project down to codex's historical result shape (no `userMessage`).
    const out = {
        decision: result.decision,
        reason: result.reason,
        durationMs: result.durationMs,
    };
    if (result.failOpenReason !== undefined)
        out.failOpenReason = result.failOpenReason;
    return out;
}
//# sourceMappingURL=guard.js.map