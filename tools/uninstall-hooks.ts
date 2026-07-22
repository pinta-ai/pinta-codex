/**
 * Remove this plugin's entries from `~/.codex/hooks.json`.
 *
 * Matches entries whose `command` references this plugin's dist/index.js
 * absolute path. Other users' hook entries are left untouched.
 */

import fs from "node:fs";
import {
  CODEX_HOOKS_PATH,
  readJsonAllowMissing,
  stripPintaCodex,
  type HooksFile,
} from "./_lib.js";

const dryRun = process.argv.includes("--dry-run");

function main(): void {
  if (!fs.existsSync(CODEX_HOOKS_PATH)) {
    process.stdout.write(`[uninstall-hooks] nothing to do: ${CODEX_HOOKS_PATH} does not exist\n`);
    return;
  }
  const existing: HooksFile = readJsonAllowMissing(CODEX_HOOKS_PATH, { hooks: {} });
  const { next, removed } = stripPintaCodex(existing);
  const serialized = JSON.stringify(next, null, 2) + "\n";

  if (dryRun) {
    process.stdout.write(
      `--- ${CODEX_HOOKS_PATH} (dry run, ${removed} entries would be removed) ---\n`,
    );
    process.stdout.write(serialized);
    return;
  }

  fs.writeFileSync(CODEX_HOOKS_PATH, serialized, "utf-8");
  process.stdout.write(`[uninstall-hooks] removed ${removed} entries from ${CODEX_HOOKS_PATH}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[uninstall-hooks] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
