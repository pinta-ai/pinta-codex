"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePostToolUse = handlePostToolUse;
const emit_js_1 = require("./emit.js");
async function handlePostToolUse(event, config) {
    await (0, emit_js_1.emitEvent)(event, config, { trace: "current" });
    return 0;
}
//# sourceMappingURL=post-tool-use.js.map