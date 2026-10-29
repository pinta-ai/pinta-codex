// Codex enrollment — ported verbatim from pinta-manager
// sidecar/src/enroll/codex-plugin.ts (troy §4.2 applied to enrollment: the
// wrapper owns how it is registered into its host). Behavior must stay
// byte-identical with what the manager shipped; only the contract types
// changed (InstallContext → EnrollContext, ctx.codexVersion → ctx.hostVersion,
// AdaptorCodexPlugin → CodexPluginInstall narrowed from the raw manifest
// install block).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { EnrollContext, EnrollApplyResult } from './types.js';
import { resolveTokenMap } from './types.js';
import { writeAtomicWithBackup } from './fs-util.js';
import { isAtLeast } from './semver.js';
import { renderHookCommand, toCommandPath } from './node-binary.js';
import { adaptorPathPrefix, isManagerOwnedHookCommand } from './hook-ownership.js';
import { mergeAndWriteEnvFile } from './hook-env.js';

// Re-exported for callers/tests that historically imported it from here.
export { adaptorPathPrefix };
import {
  buildHooksStateEntries,
  ensureCodexHooksStateEntries,
  nodePlatformToHookPlatform,
} from './hooks-state.js';

/** The catalog manifest `install` block for a `codex-plugin` target. */
export interface CodexPluginInstall {
  dist_root: string;
  hooks_template: string;
  env_file_keys: Record<string, string>;
}

/** Narrow the raw manifest install block; throws on a shape this wrapper can't run. */
export function asCodexPluginInstall(install: Record<string, unknown>): CodexPluginInstall {
  if (typeof install.dist_root !== 'string' || typeof install.hooks_template !== 'string') {
    throw new Error('codex-plugin: install block needs string dist_root and hooks_template');
  }
  const envKeys =
    install.env_file_keys && typeof install.env_file_keys === 'object'
      ? (install.env_file_keys as Record<string, string>)
      : {};
  return { dist_root: install.dist_root, hooks_template: install.hooks_template, env_file_keys: envKeys };
}

/**
 * codex v0.129.0 renamed [features].codex_hooks → [features].hooks.
 * Modern branch (>= 0.129.0 or unknown) writes `hooks = true` and strips any
 * residual `codex_hooks = …` lines (codex emits a deprecation warning otherwise).
 * Legacy branch (< 0.129.0) preserves the historical `codex_hooks = true` behavior.
 */
const HOOKS_RENAME_VERSION = '0.129.0';

function isModernCodex(codexVersion: string | undefined): boolean {
  return !codexVersion || isAtLeast(codexVersion, HOOKS_RENAME_VERSION);
}

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}
export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
export interface HooksFile {
  hooks: Record<string, HookMatcher[]>;
}

// --- TOML manipulation: [features].codex_hooks / hooks branching ---

/**
 * Ensure the codex `[features]` section enables the hook feature flag for the
 * detected codex version.
 *
 * - `codexVersion >= 0.129.0` (or `undefined` → treat as latest per F1 policy):
 *   ensure `hooks = true` AND strip any residual `codex_hooks = …` lines
 *   (codex emits a deprecation warning if the legacy key is present).
 * - `codexVersion < 0.129.0`: ensure `codex_hooks = true` (historical behavior).
 *   `hooks = …` is left untouched — codex pre-0.129.0 ignores unknown keys
 *   silently (verified H1), so we don't go out of our way to clean it up.
 *
 * Pure string transform on TOML: tolerant of formatting, preserves other
 * sections/keys, no full TOML parse required.
 */
export function ensureCodexFeaturesHookFlag(
  content: string,
  codexVersion: string | undefined,
): { next: string; changed: boolean } {
  const modern = isModernCodex(codexVersion);
  const targetKey = modern ? 'hooks' : 'codex_hooks';
  const stripLegacy = modern;

  const sectionRe = /^\[features\]\s*$/m;
  const match = content.match(sectionRe);
  if (!match) {
    const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    const suffix = content.length === 0 ? '' : '\n';
    return {
      next: content + sep + suffix + `[features]\n${targetKey} = true\n`,
      changed: true,
    };
  }
  const sectionStart = match.index! + match[0].length;
  const rest = content.slice(sectionStart);
  const nextSection = rest.match(/\n\[[^\]]+\]\s*$/m);
  const sectionEnd = nextSection ? sectionStart + nextSection.index! : content.length;
  const originalBody = content.slice(sectionStart, sectionEnd);
  let body = originalBody;

  if (stripLegacy) {
    body = body.replace(
      /^[ \t]*codex_hooks[ \t]*=[ \t]*(?:true|false|"[^"]*"|'[^']*')[ \t]*\n?/gm,
      '',
    );
  }

  const keyRe = new RegExp(
    `^([ \\t]*)${targetKey}[ \\t]*=[ \\t]*(true|false|"[^"]*"|'[^']*')[ \\t]*$`,
    'm',
  );
  const keyMatch = body.match(keyRe);
  if (keyMatch) {
    if (keyMatch[2] !== 'true') {
      body = body.replace(keyRe, `${keyMatch[1] ?? ''}${targetKey} = true`);
    }
  } else {
    const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
    body = body + `${sep}${targetKey} = true\n`;
  }

  if (body === originalBody) {
    return { next: content, changed: false };
  }
  return {
    next: content.slice(0, sectionStart) + body + content.slice(sectionEnd),
    changed: true,
  };
}

// --- hooks.json parse ---

/**
 * Safely parse a hooks.json file content. Returns { hooks: {} } on empty
 * content, non-object values, or JSON parse errors — so callers never throw
 * on a user-emptied or corrupted file.
 */
function safeParseHooks(content: string): HooksFile {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.hooks && typeof parsed.hooks === 'object') {
      return parsed as HooksFile;
    }
    return { hooks: {} };
  } catch {
    return { hooks: {} };
  }
}

// --- hooks template resolve ---

/**
 * Expand `${CODEX_PLUGIN_ROOT}` placeholders inside a parsed hooks template's
 * command strings. Critically, this runs AFTER `JSON.parse` — so Windows paths
 * containing backslashes (e.g. `C:\Users\…`) never enter the JSON text where
 * `\U` would trigger `SyntaxError: Bad escaped character`. The final
 * `JSON.stringify` of the merged structure handles the backslash escaping.
 */
export function expandHooksPluginRoot(template: HooksFile, pluginRoot: string): HooksFile {
  const out: HooksFile = { hooks: {} };
  for (const [event, matchers] of Object.entries(template.hooks ?? {})) {
    out.hooks[event] = matchers.map((m) => ({
      ...(m.matcher !== undefined ? { matcher: m.matcher } : {}),
      hooks: m.hooks.map((h) => ({
        ...h,
        command: h.command.replace(/\$\{CODEX_PLUGIN_ROOT\}/g, pluginRoot),
      })),
    }));
  }
  return out;
}

/**
 * Parse the raw hooks.json template and substitute `${CODEX_PLUGIN_ROOT}` in
 * command strings. Throws with the template path on parse failure so the enroll
 * runner can report which adaptor's payload is corrupt.
 */
export function resolveHooksTemplate(
  templateRaw: string,
  pluginRoot: string,
  templatePath: string,
): HooksFile {
  let parsed: HooksFile;
  try {
    parsed = JSON.parse(templateRaw) as HooksFile;
  } catch (err) {
    throw new Error(
      `codex-plugin: hooks template is not valid JSON: ${templatePath}: ${
        (err as Error).message
      }`,
    );
  }
  return expandHooksPluginRoot(parsed, pluginRoot);
}

// --- hooks.json merge ---

/**
 * Whether a codex hooks.json entry is manager-owned. Thin adapter over the
 * shared `isManagerOwnedHookCommand` (codex entries carry the command under a
 * `command` field). Kept as a named export for existing callers/tests.
 */
export function isManagerCodexHookCmd(
  cmd: { command?: string },
  adaptorRoot: string,
): boolean {
  return isManagerOwnedHookCommand(cmd.command ?? '', adaptorRoot);
}

function mergeHooks(
  existing: HooksFile,
  incoming: HooksFile,
  adaptorRoot: string,
): HooksFile {
  const merged: HooksFile = { hooks: { ...existing.hooks } };
  for (const [eventName, incomingMatchers] of Object.entries(incoming.hooks)) {
    const current = merged.hooks[eventName] ?? [];
    const cleaned = current
      .map((m) => ({
        ...m,
        hooks: m.hooks.filter((h) => !isManagerCodexHookCmd(h, adaptorRoot)),
      }))
      .filter((m) => m.hooks.length > 0);
    merged.hooks[eventName] = [...cleaned, ...incomingMatchers];
  }
  return merged;
}

function stripManagerHooks(existing: HooksFile, adaptorRoot: string): HooksFile {
  const cleaned: HooksFile = { hooks: {} };
  for (const [eventName, matchers] of Object.entries(existing.hooks)) {
    const next = matchers
      .map((m) => ({
        ...m,
        hooks: m.hooks.filter((h) => !isManagerCodexHookCmd(h, adaptorRoot)),
      }))
      .filter((m) => m.hooks.length > 0);
    if (next.length > 0) cleaned.hooks[eventName] = next;
  }
  return cleaned;
}

// --- public API ---

export async function applyCodexPlugin(
  ctx: EnrollContext,
  installRaw: Record<string, unknown>,
): Promise<EnrollApplyResult> {
  const install = asCodexPluginInstall(installRaw);
  const distAbsPath = path.join(ctx.adaptorRoot, install.dist_root);
  const hooksTemplatePath = path.join(ctx.adaptorRoot, install.hooks_template);
  if (!fs.existsSync(distAbsPath)) {
    throw new Error(`codex-plugin: dist_root missing: ${distAbsPath}`);
  }
  if (!fs.existsSync(hooksTemplatePath)) {
    throw new Error(`codex-plugin: hooks_template missing: ${hooksTemplatePath}`);
  }

  const codexHome = path.join(ctx.homeDir, '.codex');
  const configTomlPath = path.join(codexHome, 'config.toml');
  const hooksPath = path.join(codexHome, 'hooks.json');
  const envFilePath = path.join(codexHome, 'pinta-codex.env');

  await fsp.mkdir(codexHome, { recursive: true });

  // 1. Compute merged hooks.json in memory (don't write yet — config.toml's
  //    hooks.state entries must reference the post-merge structure).
  // dist_root 가 'package/dist' 면 plugin root 는 path.dirname(distAbsPath) = '<adaptorRoot>/package'.
  // Parse the template FIRST, then substitute `${CODEX_PLUGIN_ROOT}` in the
  // parsed object's command strings — otherwise Windows backslash paths break
  // `JSON.parse` (see `resolveHooksTemplate`).
  // Forward-slash the plugin root before it enters the hook command string —
  // a Windows backslash path is mangled by the shell that runs the hook
  // (Cannot find module). codex reads env-file values separately, so the
  // native-separator path is not needed downstream here.
  const pluginRootNative = path.dirname(distAbsPath);
  const pluginRoot = toCommandPath(pluginRootNative);
  const templateRaw = fs.readFileSync(hooksTemplatePath, 'utf-8');
  const incomingHooks = resolveHooksTemplate(templateRaw, pluginRoot, hooksTemplatePath);
  // Rewrite each hook's leading `node` token. Done before merge so the
  // hooks.state trust hash (computed off mergedHooks below) reflects the
  // exact command string codex will execute.
  //
  // On Windows, route every hook through a `.cmd` launcher (written into the
  // plugin root) — codex mis-tokenizes a leading quoted node.exe path with
  // spaces and reports `hook exited with code 1`. See
  // maybeWrapHookCommandForWindows.
  for (const matchers of Object.values(incomingHooks.hooks)) {
    for (const matcher of matchers) {
      for (const h of matcher.hooks) {
        h.command = renderHookCommand(h.command, ctx.nodePath, ctx.platform, pluginRootNative);
      }
    }
  }

  const existingHooks: HooksFile = fs.existsSync(hooksPath)
    ? safeParseHooks(fs.readFileSync(hooksPath, 'utf-8'))
    : { hooks: {} };

  const mergedHooks = mergeHooks(existingHooks, incomingHooks, ctx.adaptorRoot);

  // 2. config.toml: ensure [features] hook flag + (modern) hooks.state entries.
  const tomlExisting = fs.existsSync(configTomlPath)
    ? fs.readFileSync(configTomlPath, 'utf-8')
    : '';
  const flagResult = ensureCodexFeaturesHookFlag(tomlExisting, ctx.hostVersion);
  let tomlNext = flagResult.next;
  let stateChanged = false;
  if (isModernCodex(ctx.hostVersion)) {
    const hookPlatform = nodePlatformToHookPlatform(ctx.platform);
    const entries = buildHooksStateEntries(
      mergedHooks,
      hooksPath,
      (cmd) => isManagerCodexHookCmd(cmd, ctx.adaptorRoot),
      hookPlatform,
    );
    // validKeys = every position still present in the merged hooks.json
    // (manager + user). Anything keyed to this file but outside the set is a
    // stale manager entry left by a previous, differently-shaped hooks.json.
    const validKeys = buildHooksStateEntries(mergedHooks, hooksPath, () => true, hookPlatform).map(
      (e) => e.key,
    );
    const stateResult = ensureCodexHooksStateEntries(tomlNext, entries, {
      managedPath: hooksPath,
      validKeys,
    });
    tomlNext = stateResult.next;
    stateChanged = stateResult.changed;
  }
  if (flagResult.changed || stateChanged) {
    await writeAtomicWithBackup(configTomlPath, tomlNext, ctx.backupRoot);
  }

  // 3. Write merged hooks.json. On Windows the .cmd launchers referenced here
  //    were already written (synchronously) into the plugin root during the
  //    substitution loop above, so they exist by the time codex fires a hook.
  await writeAtomicWithBackup(hooksPath, JSON.stringify(mergedHooks, null, 2) + '\n', ctx.backupRoot);

  // 4. pinta-codex.env: merge keys
  const newEnv = resolveTokenMap(install.env_file_keys, ctx.resolveToken);
  // v1: inject guard endpoint unconditionally (independent of manifest
  // env_file_keys) so existing pinta-codex versions can call /guard/evaluate
  // once Plan 5 wires the consumer side.
  newEnv['PINTA_GUARD_ENDPOINT'] = ctx.resolveToken('relay-guard-endpoint');
  // Pin pinta-codex's retry-queue storage to a manager-owned directory. Without
  // this the adaptor falls back to `process.cwd()/.plugin-data`, which on
  // Windows resolves under the launching process's cwd (e.g. `C:\Users\<u>`) and
  // is frequently unwritable → `EPERM` on failed-spans.jsonl(.lock). We create
  // the dir as the manager (same user, correct ACLs) so the hook can write to
  // it. Env-file values are not shell-parsed, so a native-separator path is
  // fine here. Folded into `newEnv` so it overrides any stale user value.
  const codexPluginDataDir = path.join(ctx.homeDir, '.pinta', 'manager', 'codex-plugin-data');
  await fsp.mkdir(codexPluginDataDir, { recursive: true });
  newEnv['CODEX_PLUGIN_DATA'] = codexPluginDataDir;
  await mergeAndWriteEnvFile(envFilePath, newEnv, ctx.backupRoot);

  return {
    installed: true,
    configPath: hooksPath,
    details: { codexHome, distAbsPath, envFilePath },
  };
}

export async function removeCodexPlugin(
  ctx: EnrollContext,
  _installRaw: Record<string, unknown>,
): Promise<EnrollApplyResult> {
  const codexHome = path.join(ctx.homeDir, '.codex');
  const hooksPath = path.join(codexHome, 'hooks.json');
  if (!fs.existsSync(hooksPath)) {
    return { installed: false, configPath: hooksPath };
  }
  const existing: HooksFile = safeParseHooks(fs.readFileSync(hooksPath, 'utf-8'));
  const stripped = stripManagerHooks(existing, ctx.adaptorRoot);
  await writeAtomicWithBackup(hooksPath, JSON.stringify(stripped, null, 2) + '\n', ctx.backupRoot);

  // Clear the manager's hooks.state trust entries from config.toml. validKeys
  // covers only the hooks left after stripping (user hooks), so every entry the
  // manager owned — now pointing at vanished positions — is pruned, while user
  // state survives.
  const configTomlPath = path.join(codexHome, 'config.toml');
  if (fs.existsSync(configTomlPath)) {
    const tomlExisting = fs.readFileSync(configTomlPath, 'utf-8');
    const validKeys = buildHooksStateEntries(
      stripped,
      hooksPath,
      () => true,
      nodePlatformToHookPlatform(ctx.platform),
    ).map((e) => e.key);
    const result = ensureCodexHooksStateEntries(tomlExisting, [], {
      managedPath: hooksPath,
      validKeys,
    });
    if (result.changed) {
      await writeAtomicWithBackup(configTomlPath, result.next, ctx.backupRoot);
    }
  }

  // After successful remove, the adaptor is no longer installed.
  return { installed: false, configPath: hooksPath };
}
