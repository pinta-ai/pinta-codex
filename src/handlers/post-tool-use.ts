import type { PintaConfig } from "../core/config.js";
import type { PostToolUseEvent } from "../core/types.js";
import type { IdentityResolver } from "../core/identity.js";
import { Transport } from "../core/transport.js";
import { TraceManager } from "../core/trace.js";
import { buildOtlpPayload } from "../core/otlp.js";
import { authRequiredMessage } from "./auth-message.js";

export async function handlePostToolUse(
  event: PostToolUseEvent,
  config: PintaConfig,
  identityResolver: IdentityResolver,
): Promise<number> {
  const transport = new Transport(config);
  await transport.flush();

  const identity = await identityResolver.resolve();
  if (!identity) {
    process.stderr.write(authRequiredMessage());
    return 1;
  }

  const traceId = new TraceManager(config).currentTrace();
  const payload = buildOtlpPayload({ event, traceId, identity });
  await transport.send(payload);
  return 0;
}
