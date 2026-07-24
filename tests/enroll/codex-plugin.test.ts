import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyCodexPlugin,
  removeCodexPlugin,
  resolveHooksTemplate,
  expandHooksPluginRoot,
  isManagerCodexHookCmd,
  adaptorPathPrefix,
} from '../../src/enroll/codex-plugin';
import { testTokenResolver } from './test-token-resolver';
import type { EnrollContext } from '../../src/enroll/types';

let tmpHome: string;
let tmpAdaptorBase: string;
let tmpAdaptorRoot: string;
let tmpBackupRoot: string;

function makeCtx(overrides: Partial<EnrollContext> = {}): EnrollContext {
  return {
    adaptorId: 'pinta-codex',
    adaptorVersion: '1.2.0',
    adaptorRoot: tmpAdaptorRoot,
    homeDir: tmpHome,
    platform: 'darwin',
    // Default to the system-node branch — what the runner picks when
    // `node --version` succeeds. Substitution branch is exercised explicitly.
    nodePath: 'node',
    resolveToken: testTokenResolver,
    backupRoot: tmpBackupRoot,
    // Legacy branch (< v0.129.0) by default — keeps historical assertions
    // (`codex_hooks = true`, no hooks.state) valid. Modern-branch cases
    // override with `hostVersion: '0.129.0'` or `undefined`.
    hostVersion: '0.128.0',
    ...overrides,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmgr-codex-home-'));
  // Mimic production layout: <base>/pinta-codex/<version>/...  so that
  // `adaptorPathPrefix` (= path.dirname(adaptorRoot) + sep) discriminates
  // between adaptors instead of matching everything under os.tmpdir().
  tmpAdaptorBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pmgr-codex-base-'));
  tmpAdaptorRoot = path.join(tmpAdaptorBase, 'pinta-codex', '1.2.0');
  tmpBackupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pmgr-codex-bak-'));
  // Simulate extracted tarball:
  //   package/dist/index.js
  //   package/hooks.json (template with ${CODEX_PLUGIN_ROOT})
  fs.mkdirSync(path.join(tmpAdaptorRoot, 'package', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(tmpAdaptorRoot, 'package', 'dist', 'index.js'), '// pinta-codex entry');
  fs.writeFileSync(
    path.join(tmpAdaptorRoot, 'package', 'hooks.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CODEX_PLUGIN_ROOT}/dist/index.js' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node ${CODEX_PLUGIN_ROOT}/dist/index.js' }] }],
      },
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpAdaptorBase, { recursive: true, force: true });
  fs.rmSync(tmpBackupRoot, { recursive: true, force: true });
});

describe('applyCodexPlugin', () => {
  const install = {
    type: 'codex-plugin' as const,
    dist_root: 'package/dist',
    hooks_template: 'package/hooks.json',
    env_file_keys: {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'relay-endpoint' as const,
      OTEL_EXPORTER_OTLP_HEADERS: 'relay-token' as const,
    },
  };

  it('creates ~/.codex/{config.toml,hooks.json,pinta-codex.env} on fresh install', async () => {
    const result = await applyCodexPlugin(makeCtx(), install);
    expect(result.installed).toBe(true);

    const configToml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(configToml).toMatch(/\[features\]\s*[\s\S]*codex_hooks\s*=\s*true/);

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
      path.join(tmpAdaptorRoot, 'package', 'dist', 'index.js'),
    );

    const env = fs.readFileSync(path.join(tmpHome, '.codex', 'pinta-codex.env'), 'utf-8');
    expect(env).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces');
    expect(env).toContain('OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=CODEX-TOKEN');
    expect(env).toContain('PINTA_GUARD_ENDPOINT=http://127.0.0.1:4318/guard/evaluate');
  });

  it('preserves [history] and other sections when adding [features].codex_hooks', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      `[history]\nmax_lines = 1000\n`,
    );
    await applyCodexPlugin(makeCtx(), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[history]');
    expect(toml).toContain('max_lines = 1000');
    expect(toml).toContain('[features]');
    expect(toml).toContain('codex_hooks = true');
  });

  it('substitutes leading `node` in hooks.json commands with ctx.nodePath', async () => {
    const bundled = '/bundled/node';
    await applyCodexPlugin(makeCtx({ nodePath: bundled }), install);

    const hooks = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'),
    );
    const distPath = path.join(tmpAdaptorRoot, 'package', 'dist', 'index.js');
    const sessionCmd = hooks.hooks.SessionStart[0].hooks[0].command as string;
    expect(sessionCmd).toBe(`${bundled} ${distPath}`);
  });

  it('flips codex_hooks=false → true (replace value, no duplicate key)', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      `[features]\ncodex_hooks = false\n`,
    );
    await applyCodexPlugin(makeCtx(), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    const matches = toml.match(/codex_hooks\s*=/g);
    expect(matches).toHaveLength(1);
    expect(toml).toMatch(/codex_hooks\s*=\s*true/);
  });

  it('hooks.json: removes prior manager-installed entries before merging new ones', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    // User-installed entry + manager's previous-version entry (same parent dir,
    // different version) — production upgrade scenario.
    const userHookCmd = 'node /usr/local/bin/some-other-hook.js';
    const oldManagerPath = path.join(
      tmpAdaptorBase,
      'pinta-codex',
      '1.0.0',
      'package',
      'dist',
      'index.js',
    );
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [
              { type: 'command', command: userHookCmd },
              { type: 'command', command: `node ${oldManagerPath}` },
            ],
          }],
        },
      }),
    );
    await applyCodexPlugin(makeCtx(), install);
    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    const cmds = hooks.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds).toContain(userHookCmd);
    expect(cmds.some((c: string) => c.includes(oldManagerPath))).toBe(false);
    expect(cmds.some((c: string) => c.includes(path.join(tmpAdaptorRoot, 'package', 'dist', 'index.js')))).toBe(true);
  });

  it('pinta-codex.env: preserves user-set keys not in env_file_keys', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'pinta-codex.env'),
      `USER_KEY=user-value\nOTEL_EXPORTER_OTLP_TRACES_ENDPOINT=stale\n`,
    );
    await applyCodexPlugin(makeCtx(), install);
    const env = fs.readFileSync(path.join(tmpHome, '.codex', 'pinta-codex.env'), 'utf-8');
    expect(env).toContain('USER_KEY=user-value');
    expect(env).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces');
    // stale value 가 두 번 나오지 않음
    expect(env.match(/OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=/g)).toHaveLength(1);
  });

  it('refuses install when dist_root or hooks_template missing', async () => {
    const ctx = makeCtx({ adaptorRoot: '/nonexistent' });
    await expect(applyCodexPlugin(ctx, install)).rejects.toThrow();
  });

  // Root cause: pinta-codex's retry queue defaulted to process.cwd()/.plugin-data,
  // which on Windows resolved to an unwritable dir (EPERM on failed-spans.jsonl).
  // We now pin it to a manager-owned, writable directory.
  it('sets CODEX_PLUGIN_DATA to a manager-owned dir and creates it', async () => {
    await applyCodexPlugin(makeCtx(), install);
    const env = fs.readFileSync(path.join(tmpHome, '.codex', 'pinta-codex.env'), 'utf-8');
    const dataDir = path.join(tmpHome, '.pinta', 'manager', 'codex-plugin-data');
    expect(env).toContain(`CODEX_PLUGIN_DATA=${dataDir}`);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  // Root cause: codex's Windows hook runner reports `hook exited with code 1`
  // when a hook command begins with a quoted node.exe path containing spaces.
  // We route Windows hooks through a bare .cmd wrapper token instead.
  it('on win32, routes hooks through a .cmd wrapper instead of a quoted node path', async () => {
    const bundled = 'C:/Program Files/Pinta Manager/node.exe';
    await applyCodexPlugin(makeCtx({ platform: 'win32', nodePath: bundled }), install);

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    const cmd = hooks.hooks.SessionStart[0].hooks[0].command as string;
    // hooks.json now points at the wrapper, not the quoted node.exe path.
    expect(cmd).toMatch(/pinta-hook-[0-9a-f]{8}\.cmd$/);
    expect(cmd).not.toContain('node.exe');
    // The wrapper command is still recognized as manager-owned (it sits under
    // the adaptor dir), so merge-dedup, removal and drift detection keep working.
    expect(isManagerCodexHookCmd({ command: cmd }, tmpAdaptorRoot)).toBe(true);

    // Both fixture events share an identical resolved command → one wrapper file.
    const pkgDir = path.join(tmpAdaptorRoot, 'package');
    const cmdFiles = fs.readdirSync(pkgDir).filter((f) => f.endsWith('.cmd'));
    expect(cmdFiles).toHaveLength(1);

    const content = fs.readFileSync(path.join(pkgDir, cmdFiles[0]!), 'utf-8');
    expect(content.startsWith('@echo off')).toBe(true);
    expect(content).toContain('exit /b %ERRORLEVEL%');
    // Wrapper body uses native backslash paths and forwards args.
    expect(content).toContain('%*');
    const winDist = path.join(tmpAdaptorRoot, 'package', 'dist', 'index.js').replace(/\//g, '\\');
    expect(content).toContain(winDist);
  });

  it('does not create a .cmd wrapper on non-Windows', async () => {
    await applyCodexPlugin(makeCtx({ platform: 'darwin' }), install);
    const pkgDir = path.join(tmpAdaptorRoot, 'package');
    expect(fs.readdirSync(pkgDir).some((f) => f.endsWith('.cmd'))).toBe(false);
  });
});

describe('removeCodexPlugin', () => {
  const install = {
    type: 'codex-plugin' as const,
    dist_root: 'package/dist',
    hooks_template: 'package/hooks.json',
    env_file_keys: {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'relay-endpoint' as const,
      OTEL_EXPORTER_OTLP_HEADERS: 'relay-token' as const,
    },
  };

  it('removes only manager-path entries from hooks.json', async () => {
    await applyCodexPlugin(makeCtx(), install);
    // 사용자가 직접 추가한 entry 흉내
    const hooksPath = path.join(tmpHome, '.codex', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    hooks.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'node /usr/local/other.js' });
    fs.writeFileSync(hooksPath, JSON.stringify(hooks));

    await removeCodexPlugin(makeCtx(), install);
    const after = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const cmds = (after.hooks.SessionStart ?? []).flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes(tmpAdaptorRoot))).toBe(false);
    expect(cmds).toContain('node /usr/local/other.js');
  });

  it('leaves [features].codex_hooks alone (other plugins may rely on it)', async () => {
    await applyCodexPlugin(makeCtx(), install);
    await removeCodexPlugin(makeCtx(), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/codex_hooks\s*=\s*true/);
  });
});

describe('applyCodexPlugin — codex >= v0.129.0 (modern branch)', () => {
  const install = {
    type: 'codex-plugin' as const,
    dist_root: 'package/dist',
    hooks_template: 'package/hooks.json',
    env_file_keys: {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'relay-endpoint' as const,
      OTEL_EXPORTER_OTLP_HEADERS: 'relay-token' as const,
    },
  };

  it('writes [features].hooks = true (not codex_hooks)', async () => {
    await applyCodexPlugin(makeCtx({ hostVersion: '0.129.0' }), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/\[features\][\s\S]*\bhooks\s*=\s*true/);
    expect(toml).not.toMatch(/codex_hooks\s*=/);
  });

  it('migrates an existing [features].codex_hooks = true into hooks = true', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      `[features]\ncodex_hooks = true\n`,
    );
    await applyCodexPlugin(makeCtx({ hostVersion: '0.129.0' }), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/\bhooks\s*=\s*true/);
    expect(toml).not.toMatch(/codex_hooks\s*=/);
  });

  it('treats version unknown as modern (writes hooks = true)', async () => {
    await applyCodexPlugin(makeCtx({ hostVersion: undefined }), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/\bhooks\s*=\s*true/);
    expect(toml).not.toMatch(/codex_hooks\s*=/);
  });

  it('writes [hooks.state.<key>] trusted_hash for every manager-owned hook', async () => {
    await applyCodexPlugin(makeCtx({ hostVersion: '0.129.0' }), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    const hooksPath = path.join(tmpHome, '.codex', 'hooks.json');
    // Test fixture has two events: SessionStart, UserPromptSubmit
    expect(toml).toContain(`[hooks.state."${hooksPath}:session_start:0:0"]`);
    expect(toml).toContain(`[hooks.state."${hooksPath}:user_prompt_submit:0:0"]`);
    const trustLines = toml.match(/trusted_hash\s*=\s*"sha256:[0-9a-f]{64}"/g) ?? [];
    expect(trustLines.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves user-added [hooks.state.…] entries for non-manager hooks', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const userKey = '/home/u/.codex/hooks.json:custom_event:0:0';
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      `[hooks.state."${userKey}"]\ntrusted_hash = "sha256:deadbeef"\n`,
    );
    await applyCodexPlugin(makeCtx({ hostVersion: '0.129.0' }), install);
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain(`[hooks.state."${userKey}"]`);
    expect(toml).toContain('trusted_hash = "sha256:deadbeef"');
  });
});

// Regression: Windows backslash plugin roots used to be substituted into the
// JSON template text BEFORE parse, which threw `SyntaxError: Bad escaped
// character in JSON at position N` on the first `\U` (or any non-JSON escape).
// The fix parses the template first, then substitutes inside parsed strings.
describe('hooks template resolve — Windows path regression', () => {
  const winPluginRoot = 'C:\\Users\\u\\.pinta\\manager\\adaptors\\pinta-codex\\1.2.4\\package';
  const winTemplatePath = 'C:\\Users\\u\\.pinta\\manager\\adaptors\\pinta-codex\\1.2.4\\package\\hooks.json';

  it('resolveHooksTemplate: does not throw on Windows backslash pluginRoot', () => {
    const templateRaw = JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: 'node ${CODEX_PLUGIN_ROOT}/dist/index.js session-start' },
          ],
        }],
      },
    });
    // Before the fix this throws `SyntaxError: Bad escaped character in JSON at position N`.
    const resolved = resolveHooksTemplate(templateRaw, winPluginRoot, winTemplatePath);
    expect(resolved.hooks.SessionStart[0].hooks[0].command).toBe(
      `node ${winPluginRoot}/dist/index.js session-start`,
    );
  });

  it('resolveHooksTemplate: round-trips through JSON.stringify -> JSON.parse', () => {
    const templateRaw = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CODEX_PLUGIN_ROOT}\\dist\\index.js' }] }],
      },
    });
    const resolved = resolveHooksTemplate(templateRaw, winPluginRoot, winTemplatePath);
    const serialized = JSON.stringify(resolved, null, 2);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const reparsed = JSON.parse(serialized);
    expect(reparsed.hooks.SessionStart[0].hooks[0].command).toContain(winPluginRoot);
  });

  it('resolveHooksTemplate: throws a typed error when template JSON is malformed', () => {
    expect(() => resolveHooksTemplate('{not json', winPluginRoot, winTemplatePath)).toThrow(
      /hooks template is not valid JSON.*hooks\.json/,
    );
  });

  it('expandHooksPluginRoot: preserves matcher and timeout fields', () => {
    const resolved = expandHooksPluginRoot(
      {
        hooks: {
          PreToolUse: [{
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '${CODEX_PLUGIN_ROOT}/x', timeout: 5000 }],
          }],
        },
      },
      winPluginRoot,
    );
    const m = resolved.hooks.PreToolUse[0];
    expect(m.matcher).toBe('Bash');
    expect(m.hooks[0].command).toBe(`${winPluginRoot}/x`);
    expect(m.hooks[0].timeout).toBe(5000);
  });
});

// Regression: stale-cleanup regex hard-coded `/` as the path separator, so
// Windows hook entries (which use `\`) never matched and old versions stayed
// in hooks.json forever. The fix uses `path.dirname(adaptorRoot) + path.sep`
// as a prefix check, identical to claude-code-plugin.
describe('isManagerCodexHookCmd — Windows separator', () => {
  it('matches a backslash command path under the same adaptor parent', () => {
    // Simulate adaptorPathPrefix output by working in a temp tree on host OS.
    const adaptorRoot = path.join(tmpAdaptorBase, 'pinta-codex', '1.2.4');
    const prefix = adaptorPathPrefix(adaptorRoot);
    expect(prefix).toBe(path.join(tmpAdaptorBase, 'pinta-codex') + path.sep);

    const oldVersionCmd = `node ${path.join(tmpAdaptorBase, 'pinta-codex', '1.0.0', 'package', 'dist', 'index.js')}`;
    expect(isManagerCodexHookCmd({ command:oldVersionCmd }, adaptorRoot)).toBe(true);

    const userCmd = 'node /usr/local/bin/some-other.js';
    expect(isManagerCodexHookCmd({ command:userCmd }, adaptorRoot)).toBe(false);
  });

  it('matches commands containing a Windows-style backslash adaptor path', () => {
    // Synthetic Windows-style adaptorRoot — exercises the substring check
    // independent of host `path.sep`.
    const winAdaptorRoot = 'C:\\Users\\u\\.pinta\\manager\\adaptors\\pinta-codex\\1.2.4';
    const winPrefix = 'C:\\Users\\u\\.pinta\\manager\\adaptors\\pinta-codex\\';
    const oldVersionCmd =
      'node C:\\Users\\u\\.pinta\\manager\\adaptors\\pinta-codex\\1.0.0\\package\\dist\\index.js';
    // The prefix check uses `includes` so any command whose string contains the
    // parent dir is considered manager-owned — separator-agnostic.
    expect(oldVersionCmd.includes(winPrefix)).toBe(true);

    // If host is Windows, adaptorPathPrefix will produce exactly winPrefix and
    // isManagerCodexHookCmd will match. On posix hosts, path.sep === '/' so the
    // helper produces a different prefix — we instead assert the underlying
    // substring contract that the fix relies on.
    if (path.sep === '\\') {
      expect(isManagerCodexHookCmd({ command:oldVersionCmd }, winAdaptorRoot)).toBe(true);
    }
  });
});
