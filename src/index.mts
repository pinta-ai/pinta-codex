/**
 * ESM dual-entry (plan §4.2/§4.3, M5a): built to dist/index.mjs via a
 * separate `--format=esm` esbuild step (see package.json `build:esm`).
 *
 * Exports the pinta-codex `lifecycle` TranscriptSource for the pinta-manager
 * sidecar's runtime `import()` (plan: `import(~/.pinta/adaptors/pinta-codex/…mjs)`),
 * AND still works as a direct-exec Codex hook — but guarded so that
 * *importing* this module (the sidecar loading the adaptor) does not also
 * read stdin / dispatch a hook / exit the process.
 *
 * dist/index.js (CJS, built from src/index.ts) remains the hook-only,
 * always-direct-exec entry point — untouched by this change.
 *
 * Guard: `import.meta.main` is Bun-only. Comparing `import.meta.url` to the
 * realpath of `process.argv[1]` works on both Node 20 and Bun, so this file
 * behaves the same regardless of which runtime eventually execs the hook.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runHook } from "./hook.js";
import { lifecycle } from "./lifecycle/scanner.js";
import { enroll } from "./enroll/index.js";

export { lifecycle, enroll };

function isDirectlyExecuted(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // process.argv[1] missing/unreadable (e.g. REPL, unusual host) — err on
    // the side of NOT running the hook, since that's the safer default for
    // an import()-based caller.
    return false;
  }
}

async function main(): Promise<void> {
  const exitCode = await runHook();
  process.exit(exitCode);
}

if (isDirectlyExecuted()) {
  main();
}
