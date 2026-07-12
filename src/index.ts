// CJS hook entry (built to dist/index.js) — always direct-exec, unguarded,
// exactly as before the dual-entry split. Dispatch logic itself lives in
// ./hook.js, shared with the ESM entry (src/index.mts -> dist/index.mjs) so
// the two build targets cannot drift. See src/index.mts for the ESM/dual-entry
// variant (mirrors pinta-cc's A3 pattern).
import { runHook } from "./hook.js";

async function main(): Promise<void> {
  const exitCode = await runHook();
  process.exit(exitCode);
}

main();
