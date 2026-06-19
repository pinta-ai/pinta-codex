"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleUserPrompt = handleUserPrompt;
const emit_js_1 = require("./emit.js");
async function handleUserPrompt(event, config) {
    await (0, emit_js_1.emitEvent)(event, config, { trace: "new" }); // NEW trace per user turn
    return 0;
}
//# sourceMappingURL=user-prompt.js.map