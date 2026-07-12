/**
 * M5a — pinta-codex `TranscriptSource` implementation for
 * `[$CODEX_HOME ?? ~/.codex]/sessions`.
 *
 * Real-world shape observed on disk (plan §4.3, machine-verified 2026-07-12):
 *   <sessionsRoot>/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 *
 * A pure append-log — the simplest of the six wrapper corpora (plan §4.3
 * "가장 단순", §5.4 M5a "CC scanner의 아종"). Every `*.jsonl` file is a
 * session transcript (`semantics: 'append-log'`, `classify: 'session-log'`);
 * anything else under the root is treated conservatively as a wholesale
 * rewrite (`semantics: 'rewritten-doc'`, `classify: 'other'`).
 *
 * `sessionId` comes from the uuid embedded in the rollout filename itself
 * (the trailing uuid after the dash-separated timestamp) — this matches the
 * `session_meta.payload.id` field inside the file, so no fixture-reading /
 * partial-JSON-parsing is required to tag a session. Codex sessions are not
 * per-project, so `projectKey` is never set (plan: "projectKey: none —
 * omit").
 *
 * No exclusion rules for Codex (plan §4.3 "제외 규칙: 없음").
 *
 * Per plan §4.2, the lifecycle module sticks to `node:*` APIs only (no Bun-
 * specific globals) so it runs unmodified whether the sidecar host is Node
 * or Bun.
 */
import { opendir, stat } from "node:fs/promises";
import path from "node:path";

import { envFilePath } from "@pinta-ai/core";

import type {
  TranscriptClass,
  TranscriptFile,
  TranscriptSemantics,
  TranscriptSource,
} from "./types.js";

const WRAPPER_ID = "pinta-codex";

/**
 * `rollout-<timestamp>-<uuid>.jsonl`, e.g.
 * `rollout-2026-05-19T13-29-22-019e3e7e-de14-7133-af8f-7e141081752e.jsonl`
 * (colons in the timestamp are replaced with `-` on disk). Captures the
 * trailing uuid, which is the session id.
 */
const ROLLOUT_FILENAME_RE =
  /^rollout-.+-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/**
 * `[$CODEX_HOME ?? ~/.codex]/sessions` — the same `$CODEX_HOME` override
 * Codex itself (and src/core/config.ts) honors. Reuses @pinta-ai/core's
 * `envFilePath` path builder, whose override-env-var semantics are exactly
 * this (despite the name it is a generic `~/<dir>/<child>` resolver).
 */
function sessionsRoot(): string {
  return envFilePath(".codex", "sessions", "CODEX_HOME");
}

/** Relative path from `root` to `absPath`, POSIX-style (`/` separators) regardless of platform. */
function toPosixRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

function semanticsFor(relPath: string): TranscriptSemantics {
  // Pure append-log corpus (plan §4.3): every *.jsonl is a rollout session
  // log; anything else is treated conservatively as a wholesale rewrite.
  return relPath.endsWith(".jsonl") ? "append-log" : "rewritten-doc";
}

/** `classify()` — coarse content type from `relPath` alone (plan §4.2). */
export function classify(relPath: string): TranscriptClass {
  return relPath.endsWith(".jsonl") ? "session-log" : "other";
}

/** Session id embedded in a rollout filename, or undefined if it doesn't match the pattern. */
function sessionIdFor(relPath: string): string | undefined {
  const filename = relPath.slice(relPath.lastIndexOf("/") + 1);
  const match = ROLLOUT_FILENAME_RE.exec(filename);
  return match?.[1];
}

export async function roots(): Promise<string[]> {
  return [sessionsRoot()];
}

/**
 * Recursive, streaming walk of `dir` yielding every *file* found (never
 * directories), depth-first. Uses `opendir`'s own async iteration rather
 * than `readdir` so we never materialize a full directory listing (or the
 * whole tree) in memory at once (mirrors pinta-cc's A2 walkFiles).
 */
async function* walkFiles(root: string, dir: string): AsyncGenerator<{ absPath: string; relPath: string }> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    // Root doesn't exist yet (fresh install, no sessions recorded) or
    // vanished mid-walk (deleted date dir) — nothing to yield.
    return;
  }

  try {
    for await (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkFiles(root, absPath);
      } else if (entry.isFile()) {
        yield { absPath, relPath: toPosixRelPath(root, absPath) };
      }
      // Symlinks and other special entries are skipped — Codex does not
      // produce them under `sessions/`, and following them risks escaping
      // the root or cycles.
    }
  } catch {
    // Directory removed while we were iterating it — treat as end of
    // stream for this subtree rather than failing the whole scan.
    return;
  }
}

async function* scan(opts: { since?: Date }): AsyncIterable<TranscriptFile> {
  const [root] = await roots();
  const sinceMs = opts.since?.getTime();

  for await (const { absPath, relPath } of walkFiles(root, root)) {
    let st;
    try {
      st = await stat(absPath);
    } catch {
      // Removed between listing and stat (TOCTOU) — skip, next cycle will
      // simply not see it either (plan §4.1 "삭제됨: 스킵").
      continue;
    }

    if (sinceMs !== undefined && st.mtime.getTime() <= sinceMs) {
      continue;
    }

    yield {
      relPath,
      absPath,
      size: st.size,
      mtime: st.mtime,
      sessionId: sessionIdFor(relPath),
      // Codex sessions aren't per-project (plan §4.3) — projectKey omitted.
      semantics: semanticsFor(relPath),
    };
  }
}

export const lifecycle: TranscriptSource = {
  id: WRAPPER_ID,
  roots,
  scan,
  classify,
  // No `snapshot()` — Codex has no database-semantics files (plan §4.3).
};
