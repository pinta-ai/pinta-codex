import type { PintaCodexConfig } from "../core/config.js";
import type { PostToolUseEvent } from "../core/types.js";
import { Transport } from "../core/transport.js";
import { TraceManager } from "../core/trace.js";
import { buildOtlpPayload } from "../core/otlp.js";

export async function handlePostToolUse(
  event: PostToolUseEvent,
  config: PintaCodexConfig,
): Promise<number> {
  const transport = new Transport(config);
  await transport.flush();
  const traceId = new TraceManager(config).currentTrace();
  const payload = buildOtlpPayload({ event, traceId });
  await transport.send(payload);
  return 0;
}
