import path from 'node:path';
import type { EnrollSource } from './types.js';
import { applyCodexPlugin, removeCodexPlugin } from './codex-plugin.js';

/**
 * The enroll lifecycle export the pinta-manager sidecar drives (troy §4.2
 * applied to enrollment). pinta-codex owns how it is registered into Codex:
 * `~/.codex/hooks.json` merge, the `[features]` hook flag (version-branched at
 * codex 0.129.0 via `ctx.hostVersion`), the `[hooks.state]` trust-hash
 * entries, and `~/.codex/pinta-codex.env`. The manager only downloads the
 * adaptor, resolves tokens, and dispatches — it carries no Codex knowledge.
 */
export const enroll: EnrollSource = {
  id: 'pinta-codex',
  hooks: {
    installType: 'codex-plugin',
    apply: applyCodexPlugin,
    remove: removeCodexPlugin,
    watchPaths: (homeDir) => [
      path.join(homeDir, '.codex', 'config.toml'),
      path.join(homeDir, '.codex', 'hooks.json'),
      path.join(homeDir, '.codex', 'pinta-codex.env'),
    ],
  },
};

export type {
  EnrollSource,
  EnrollContext,
  EnrollApplyResult,
  HookEnrollProvider,
  McpConfigSource,
  McpConfigScope,
  McpDetectContext,
  McpServerEntry,
} from './types.js';
