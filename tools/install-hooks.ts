/**
 * Merge this plugin's hooks into `~/.codex/hooks.json` with the plugin's
 * absolute path baked in.
 *
 * See `tools/_lib.ts` for the heavy lifting. For the rationale, see README.md
 * (section "Install") and doctor's "hooks.json" check.
 *
 * Usage:
 *   npx tsx tools/install-hooks.ts              # merge into ~/.codex/hooks.json
 *   npx tsx tools/install-hooks.ts --dry-run    # print the final file, don't write
 *   CODEX_HOME=/abs/path npx tsx tools/install-hooks.ts
 */

import fs from "node:fs";
import {
  CODEX_HOME,
  CODEX_HOOKS_PATH,
  PLUGIN_ENTRY,
  loadResolvedTemplate,
  mergeHooks,
  readJsonAllowMissing,
  type HooksFile,
} from "./_lib.js";

const dryRun = process.argv.includes("--dry-run");

function main(): void {
  if (!fs.existsSync(PLUGIN_ENTRY)) {
    process.stderr.write(
      `[install-hooks] plugin entry missing: ${PLUGIN_ENTRY}\n` +
        `  Run 'npm run build' before installing hooks.\n`,
    );
    process.exit(1);
  }

  const incoming = loadResolvedTemplate();
  const existing: HooksFile = readJsonAllowMissing(CODEX_HOOKS_PATH, { hooks: {} });
  const { next: merged, staleRemoved } = mergeHooks(existing, incoming);
  const serialized = JSON.stringify(merged, null, 2) + "\n";

  if (dryRun) {
    process.stdout.write(`--- ${CODEX_HOOKS_PATH} (dry run) ---\n`);
    process.stdout.write(serialized);
    return;
  }

  const previous = fs.existsSync(CODEX_HOOKS_PATH)
    ? fs.readFileSync(CODEX_HOOKS_PATH, "utf-8")
    : null;

  if (previous === serialized) {
    process.stdout.write(`[install-hooks] already up to date: ${CODEX_HOOKS_PATH}\n`);
    process.stdout.write(`[install-hooks] plugin entry: ${PLUGIN_ENTRY}\n`);
    return;
  }

  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.writeFileSync(CODEX_HOOKS_PATH, serialized, "utf-8");
  if (staleRemoved > 0) {
    process.stdout.write(
      `[install-hooks] removed ${staleRemoved} stale pinta-codex ` +
        `${staleRemoved === 1 ? "entry" : "entries"} (prior install at a different path)\n`,
    );
  }
  process.stdout.write(
    `[install-hooks] ${previous === null ? "created" : "updated"} ${CODEX_HOOKS_PATH}\n`,
  );
  process.stdout.write(`[install-hooks] plugin entry: ${PLUGIN_ENTRY}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[install-hooks] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
