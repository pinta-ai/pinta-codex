"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transport = void 0;
// codex-specific binding over the shared DiskTransport in @pinta-ai/core. Keeps
// the `new Transport(config)` call shape used by the handlers. Unlike the other
// adapters, codex resolves the endpoint + headers up front in config.ts (the
// codex CLI does not inject env into the hook subprocess), so we supply a
// resolveOptions that reads from the already-built config rather than env vars.
const core_1 = require("@pinta-ai/core");
class Transport extends core_1.DiskTransport {
    constructor(config) {
        super({
            pluginData: config.pluginData,
            logPrefix: "pinta-codex",
            resolveOptions: () => config.endpoint
                ? { endpoint: config.endpoint, headers: config.headers }
                : null,
        });
    }
}
exports.Transport = Transport;
//# sourceMappingURL=transport.js.map