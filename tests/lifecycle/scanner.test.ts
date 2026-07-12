import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lifecycle, classify } from "../../src/lifecycle/scanner";
import type { TranscriptFile } from "../../src/lifecycle/types";

const SAVED_CODEX_HOME = process.env.CODEX_HOME;

const UUID_A = "019e3e7e-de14-7133-af8f-7e141081752e";
const UUID_B = "019e80e8-86fb-7461-bad8-13372090d347";

const REL_A = "2026/05/19/rollout-2026-05-19T13-29-22-" + UUID_A + ".jsonl";
const REL_B = "2026/06/01/rollout-2026-06-01T10-59-43-" + UUID_B + ".jsonl";
const REL_OTHER = "2026/06/01/notes.txt";

let tmpRoot: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pinta-codex-lifecycle-"));
}

function write(relPath: string, content = ""): string {
  const abs = path.join(tmpRoot, "sessions", relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Builds the fixture tree described in the task:
 *   sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl (x2, different dated dirs)
 *   sessions/YYYY/MM/DD/notes.txt (non-jsonl stray file)
 */
function buildFixture(): void {
  write(REL_A, '{"type":"session_meta","payload":{"id":"' + UUID_A + '"}}\n');
  write(REL_B, '{"type":"session_meta","payload":{"id":"' + UUID_B + '"}}\n');
  write(REL_OTHER, "not a transcript\n");
}

async function collect(iter: AsyncIterable<TranscriptFile>): Promise<Map<string, TranscriptFile>> {
  const out = new Map<string, TranscriptFile>();
  for await (const file of iter) {
    out.set(file.relPath, file);
  }
  return out;
}

beforeEach(() => {
  tmpRoot = makeTmpDir();
  process.env.CODEX_HOME = tmpRoot;
  buildFixture();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (SAVED_CODEX_HOME === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = SAVED_CODEX_HOME;
  }
});

describe("lifecycle.id / roots()", () => {
  it("id is 'pinta-codex'", () => {
    expect(lifecycle.id).toBe("pinta-codex");
  });

  it("roots() resolves to $CODEX_HOME/sessions", async () => {
    const roots = await lifecycle.roots();
    expect(roots).toEqual([path.join(tmpRoot, "sessions")]);
  });
});

describe("scan() — POSIX relPaths, semantics, sessionId", () => {
  it("yields every file in the fixture tree with POSIX-style relPaths", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(new Set(files.keys())).toEqual(new Set([REL_A, REL_B, REL_OTHER]));
    for (const relPath of files.keys()) {
      expect(relPath).not.toContain("\\");
    }
  });

  it("classifies *.jsonl rollout files as append-log, everything else as rewritten-doc", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.get(REL_A)!.semantics).toBe("append-log");
    expect(files.get(REL_B)!.semantics).toBe("append-log");
    expect(files.get(REL_OTHER)!.semantics).toBe("rewritten-doc");
  });

  it("extracts sessionId from the trailing uuid in the rollout filename", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.get(REL_A)!.sessionId).toBe(UUID_A);
    expect(files.get(REL_B)!.sessionId).toBe(UUID_B);
  });

  it("does not tag a sessionId on non-rollout files", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.get(REL_OTHER)!.sessionId).toBeUndefined();
  });

  it("never tags a projectKey — Codex sessions aren't per-project", async () => {
    const files = await collect(lifecycle.scan({}));
    for (const file of files.values()) {
      expect(file.projectKey).toBeUndefined();
    }
  });

  it("absPath round-trips to a real, readable file", async () => {
    const files = await collect(lifecycle.scan({}));
    const file = files.get(REL_A)!;
    expect(fs.existsSync(file.absPath)).toBe(true);
    expect(file.size).toBeGreaterThan(0);
  });
});

describe("scan({ since }) — mtime filtering", () => {
  it("only yields files with mtime strictly after `since`", async () => {
    const allBefore = await collect(lifecycle.scan({}));
    const cutoff = new Date();

    // Push every existing fixture file's mtime behind the cutoff.
    for (const file of allBefore.values()) {
      const past = new Date(cutoff.getTime() - 60_000);
      fs.utimesSync(file.absPath, past, past);
    }

    // One file touched after the cutoff.
    const freshAbsPath = path.join(tmpRoot, "sessions", REL_OTHER);
    const future = new Date(cutoff.getTime() + 60_000);
    fs.utimesSync(freshAbsPath, future, future);

    const filtered = await collect(lifecycle.scan({ since: cutoff }));
    expect(Array.from(filtered.keys())).toEqual([REL_OTHER]);
  });

  it("yields nothing when since is after every file's mtime", async () => {
    const farFuture = new Date(Date.now() + 3600_000);
    const filtered = await collect(lifecycle.scan({ since: farFuture }));
    expect(filtered.size).toBe(0);
  });

  it("yields everything when since is omitted", async () => {
    const filtered = await collect(lifecycle.scan({}));
    expect(filtered.size).toBe(3);
  });
});

describe("classify()", () => {
  it("classifies *.jsonl rollout files as session-log", () => {
    expect(classify(REL_A)).toBe("session-log");
    expect(classify(REL_B)).toBe("session-log");
  });

  it("classifies anything else as other", () => {
    expect(classify(REL_OTHER)).toBe("other");
  });

  it("is also reachable as lifecycle.classify", () => {
    expect(lifecycle.classify?.(REL_A)).toBe("session-log");
  });
});
