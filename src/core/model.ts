import type { BaseEvent } from "./types.js";
import {
  consensus, eventTime, identifier, modelName, readTranscript, record,
  timestamp, type ModelEvidence,
} from "./model-evidence.js";

/** Turn context identifies a requested model, not a provider's routed response. */
export function resolveModel(event: BaseEvent, now: number): ModelEvidence | undefined {
  const explicit = modelName(event.model);
  if (explicit) return { name: explicit, source: "hook.model" };
  try {
    return fromTranscript(event, now);
  } catch {
    return undefined;
  }
}

function fromTranscript(event: BaseEvent, now: number): ModelEvidence | undefined {
  // These events describe a child, whereas their turn_id may describe the parent.
  if (event.hook_event_name === "SubagentStart" || event.hook_event_name === "SubagentStop") return undefined;
  const session = identifier(event.session_id);
  const turn = identifier(event.turn_id);
  const at = eventTime(event, now);
  if (!session || !turn || at === undefined
    || (event.agent_id !== undefined && event.agent_id !== session)) return undefined;

  const transcript = readTranscript(event.transcript_path);
  const first = transcript?.first;
  const started = timestamp(first?.timestamp);
  if (!transcript || first?.type !== "session_meta" || record(first.payload)?.id !== session
    || started === undefined || started > at) return undefined;
  if (transcript.rows.some((row) => row.type === "session_meta" && record(row.payload)?.id !== session)) return undefined;

  const candidates: Array<ModelEvidence | undefined> = [];
  for (const row of transcript.rows) {
    const context = record(row.payload);
    const time = timestamp(row.timestamp);
    if (row.type !== "turn_context" || context?.turn_id !== turn
      || time === undefined || time > at || time < started) continue;
    const name = modelName(context.model);
    candidates.push(name ? { name, source: "transcript.turn_context" } : undefined);
  }
  return consensus(candidates);
}
