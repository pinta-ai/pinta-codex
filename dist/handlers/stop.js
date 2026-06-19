"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleStop = handleStop;
const emit_js_1 = require("./emit.js");
async function handleStop(event, config) {
    await (0, emit_js_1.emitEvent)(event, config, { trace: "current" });
    return 0;
}
//# sourceMappingURL=stop.js.map