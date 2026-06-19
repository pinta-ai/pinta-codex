"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSession = handleSession;
const emit_js_1 = require("./emit.js");
async function handleSession(event, config) {
    await (0, emit_js_1.emitEvent)(event, config, { trace: "current" });
    return 0;
}
//# sourceMappingURL=session.js.map