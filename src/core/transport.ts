// codex-specific binding over the shared DiskTransport in @pinta-ai/core. Keeps
// the `new Transport(config)` call shape used by the handlers. Unlike the other
// adapters, codex resolves the endpoint + headers up front in config.ts (the
// codex CLI does not inject env into the hook subprocess), so we supply a
// resolveOptions that reads from the already-built config rather than env vars.
import { DiskTransport } from "@pinta-ai/core";
import type { PintaCodexConfig } from "./config.js";

export class Transport extends DiskTransport {
  constructor(config: PintaCodexConfig) {
    super({
      pluginData: config.pluginData,
      logPrefix: "pinta-codex",
      resolveOptions: () =>
        config.endpoint
          ? { endpoint: config.endpoint, headers: config.headers }
          : null,
    });
  }
}
