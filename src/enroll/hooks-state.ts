import crypto from 'node:crypto';

/**
 * codex v0.129.0+ stores per-hook trust state under `[hooks.state."<key>"]` in
 * `~/.codex/config.toml`, where `<key>` is:
 *
 *   "<absolute hooks.json path>:<event_label>:<matcher_idx>:<hook_idx>"
 *
 * `<event_label>` is the snake_case label codex uses internally, NOT the
 * PascalCase key from hooks.json. Each entry carries
 * `trusted_hash = "sha256:…"`. Without it, codex prompts the user to trust the
 * hook on first run. To absorb that UX, manager pre-writes the trust state for
 * every hook it owns.
 *
 * The hash algorithm mirrors `command_hook_hash` in
 * `codex-rs/hooks/src/engine/discovery.rs` (codex rusty-v8-v146.4.0-1955-g05e171094d):
 *
 *  1. Build a NormalizedHookIdentity = `{ event_name, [matcher?], hooks: [normalized handler] }`.
 *  2. Recursively sort object keys, serialize as compact JSON (no whitespace).
 *  3. SHA-256 of the UTF-8 bytes → "sha256:" + lowercase hex.
 *
 * See `hook_trust_current_hash_report.md` and
 * `docs/features/v0.1.5/codex-hooks-flag-migration.md` §1 Q3 + §2 H4.
 */

export type Platform = 'posix' | 'windows';

interface HookEventSpec {
  jsonKey: string;
  label: string;
  supportsMatcher: boolean;
}

const EVENT_SPECS: HookEventSpec[] = [
  { jsonKey: 'PreToolUse', label: 'pre_tool_use', supportsMatcher: true },
  { jsonKey: 'PermissionRequest', label: 'permission_request', supportsMatcher: true },
  { jsonKey: 'PostToolUse', label: 'post_tool_use', supportsMatcher: true },
  { jsonKey: 'PreCompact', label: 'pre_compact', supportsMatcher: true },
  { jsonKey: 'PostCompact', label: 'post_compact', supportsMatcher: true },
  { jsonKey: 'SessionStart', label: 'session_start', supportsMatcher: true },
  { jsonKey: 'UserPromptSubmit', label: 'user_prompt_submit', supportsMatcher: false },
  { jsonKey: 'Stop', label: 'stop', supportsMatcher: false },
];

const EVENT_SPEC_BY_JSON_KEY = new Map(EVENT_SPECS.map((s) => [s.jsonKey, s]));

export interface HookCommand {
  type: string;
  command?: string;
  commandWindows?: string;
  command_windows?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HooksFile {
  hooks: Record<string, HookMatcher[]>;
}

export interface HooksStateEntry {
  key: string;
  trustedHash: string;
}

export function nodePlatformToHookPlatform(platform: NodeJS.Platform): Platform {
  return platform === 'win32' ? 'windows' : 'posix';
}

/**
 * Compute codex's canonical trust hash for a single command hook handler.
 * Returns undefined when the handler is ineligible: non-command type,
 * `async: true`, or empty command after platform selection.
 */
export function commandHookHash(
  eventJsonKey: string,
  matcher: string | undefined,
  handler: HookCommand,
  platform: Platform,
): string | undefined {
  const spec = EVENT_SPEC_BY_JSON_KEY.get(eventJsonKey);
  if (!spec) return undefined;
  if (handler.type !== 'command') return undefined;
  if (handler.async === true) return undefined;

  const command = selectCommand(handler, platform);
  if (command === undefined || command.trim() === '') return undefined;

  const timeout = normalizeTimeout(handler.timeout);
  const normalizedHandler: Record<string, unknown> = {
    type: 'command',
    command,
    timeout,
    async: false,
  };
  if (handler.statusMessage !== undefined) {
    normalizedHandler.statusMessage = handler.statusMessage;
  }

  const identity: Record<string, unknown> = {
    event_name: spec.label,
    hooks: [normalizedHandler],
  };
  if (spec.supportsMatcher && matcher !== undefined) {
    identity.matcher = matcher;
  }

  return sha256ForCanonicalJson(identity);
}

function selectCommand(handler: HookCommand, platform: Platform): string | undefined {
  if (platform === 'windows') {
    const winCmd = handler.commandWindows ?? handler.command_windows;
    if (winCmd !== undefined) return winCmd;
  }
  return handler.command;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || value === null) return 600;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`timeout must be a non-negative integer, got ${String(value)}`);
  }
  return Math.max(value, 1);
}

function sha256ForCanonicalJson(value: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(value));
  const digest = crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
  return `sha256:${digest}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const v = input[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Build hooks.state entries for every manager-owned hook in `mergedHooks`.
 * Walks the post-merge hooks structure so matcher/hook indices match what
 * gets written to disk.
 *
 * Skips handlers that `isManagerHook` rejects (= user-installed hooks) and
 * handlers that codex itself would not hash (non-command, async: true, empty
 * command, unknown event key).
 */
export function buildHooksStateEntries(
  mergedHooks: HooksFile,
  hooksJsonPath: string,
  isManagerHook: (cmd: HookCommand) => boolean,
  platform: Platform,
): HooksStateEntry[] {
  const out: HooksStateEntry[] = [];
  for (const [eventJsonKey, matchers] of Object.entries(mergedHooks.hooks)) {
    const spec = EVENT_SPEC_BY_JSON_KEY.get(eventJsonKey);
    if (!spec) continue;
    matchers.forEach((matcherGroup, matcherIdx) => {
      const matcher = spec.supportsMatcher ? matcherGroup.matcher : undefined;
      matcherGroup.hooks.forEach((handler, hookIdx) => {
        if (!isManagerHook(handler)) return;
        const trustedHash = commandHookHash(eventJsonKey, matcher, handler, platform);
        if (!trustedHash) return;
        out.push({
          key: `${hooksJsonPath}:${spec.label}:${matcherIdx}:${hookIdx}`,
          trustedHash,
        });
      });
    });
  }
  return out;
}

/**
 * Insert / update `[hooks.state."<key>"] trusted_hash = "<hash>"` blocks in a
 * codex config.toml, and (optionally) prune stale entries the manager no longer
 * owns. Existing entries for desired keys are replaced; entries for unrelated
 * keys (other hooks.json files, user hooks still present) are left alone —
 * H8 confirms codex/manager don't conflict on this surface.
 *
 * Strategy:
 * - For each desired entry, look for an existing `[hooks.state."<key>"]`
 *   section. If present, ensure its `trusted_hash` matches; if absent, append
 *   a new section block at end-of-file.
 * - When `prune` is supplied, remove every `[hooks.state."<key>"]` section
 *   whose key references the managed hooks.json (`prune.managedPath`) but whose
 *   position no longer exists in that file (`prune.validKeys`). This clears
 *   orphans left when a manager hook is dropped or its matcher/hook index
 *   shifts (and, on uninstall, when every manager hook is removed). Pruning is
 *   scoped to `managedPath`, so other files' entries — and positions still
 *   occupied by user hooks (which appear in `validKeys`) — survive untouched.
 *
 * The order matters: upserts run first, so freshly-appended desired sections
 * are members of `validKeys` and are never pruned.
 */
export interface PruneHooksState {
  /** Absolute hooks.json path whose state entries the manager owns. */
  managedPath: string;
  /**
   * Keys for every position that still exists in the managed hooks.json
   * (manager + user hooks). Any managed-path entry outside this set is stale.
   */
  validKeys: Iterable<string>;
}

export function ensureCodexHooksStateEntries(
  content: string,
  entries: HooksStateEntry[],
  prune?: PruneHooksState,
): { next: string; changed: boolean } {
  if (entries.length === 0 && !prune) return { next: content, changed: false };

  let next = content;
  let changed = false;

  for (const entry of entries) {
    const escapedKey = escapeTomlBasicString(entry.key);
    const sectionHeader = `[hooks.state."${escapedKey}"]`;
    const desiredTrust = `trusted_hash = "${entry.trustedHash}"`;

    const headerIdx = next.indexOf(sectionHeader);
    if (headerIdx < 0) {
      const sep = next.length === 0 || next.endsWith('\n') ? '' : '\n';
      const blank = next.length === 0 ? '' : '\n';
      next = next + sep + blank + `${sectionHeader}\n${desiredTrust}\n`;
      changed = true;
      continue;
    }

    const bodyStart = headerIdx + sectionHeader.length;
    const restAfterHeader = next.slice(bodyStart);
    const nextSection = restAfterHeader.match(/\n\[[^\]]+\]/);
    const bodyEnd = nextSection ? bodyStart + nextSection.index! : next.length;
    const body = next.slice(bodyStart, bodyEnd);

    const trustRe = /^[ \t]*trusted_hash[ \t]*=[ \t]*"[^"]*"[ \t]*$/m;
    if (trustRe.test(body)) {
      const replaced = body.replace(trustRe, desiredTrust);
      if (replaced !== body) {
        next = next.slice(0, bodyStart) + replaced + next.slice(bodyEnd);
        changed = true;
      }
    } else {
      const sep = body.length === 0 || body.endsWith('\n') ? '\n' : '\n';
      const insertion = `${sep}${desiredTrust}\n`;
      next = next.slice(0, bodyEnd) + insertion + next.slice(bodyEnd);
      changed = true;
    }
  }

  if (prune) {
    const valid = prune.validKeys instanceof Set ? prune.validKeys : new Set(prune.validKeys);
    const pruned = pruneManagerHooksState(next, prune.managedPath, valid);
    if (pruned.changed) {
      next = pruned.next;
      changed = true;
    }
  }

  return { next, changed };
}

/**
 * Drop `[hooks.state."<key>"]` sections whose key starts with `<managedPath>:`
 * and is absent from `validKeys`. A section spans its header line through the
 * blank/body lines up to (but not including) the next `[...]` header or EOF.
 */
function pruneManagerHooksState(
  content: string,
  managedPath: string,
  validKeys: Set<string>,
): { next: string; changed: boolean } {
  const prefix = `${managedPath}:`;
  const headerRe = /^\[hooks\.state\."((?:[^"\\]|\\.)*)"\][ \t]*$/gm;
  const removals: Array<{ start: number; end: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) {
    const key = unescapeTomlBasicString(m[1]);
    if (!key.startsWith(prefix)) continue;
    if (validKeys.has(key)) continue;

    const start = m.index;
    const after = content.slice(m.index + m[0].length);
    const rel = after.search(/\n\[/);
    const end = rel < 0 ? content.length : m.index + m[0].length + rel + 1;
    removals.push({ start, end });
  }

  if (removals.length === 0) return { next: content, changed: false };

  let next = content;
  for (let i = removals.length - 1; i >= 0; i--) {
    next = next.slice(0, removals[i].start) + next.slice(removals[i].end);
  }
  return { next, changed: true };
}

function escapeTomlBasicString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeTomlBasicString(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}
