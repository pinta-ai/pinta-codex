"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDefault = handleDefault;
/**
 * Catch-all for hooks Codex may add in the future that we do not route yet.
 * Exits 0 silently so unknown hooks stay fail-open.
 */
async function handleDefault(_event) {
    return 0;
}
//# sourceMappingURL=default.js.map