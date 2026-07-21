/**
 * Restoration scenario tests for applyCodexPlugin.
 *
 * Each test sets up ~/.codex files in a damaged/modified state, calls
 * applyCodexPlugin, then asserts that files are restored to canonical state
 * with user content preserved where appropriate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyCodexPlugin } from '../../src/enroll/codex-plugin';
import { testTokenResolver } from './test-token-resolver';
import type { EnrollContext } from '../../src/enroll/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpAdaptorRoot: string;
let tmpBackupRoot: string;

/** Creates a tmpdir representing ~/.codex's parent (the home dir). */
function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pmgr-codex-restore-home-'));
}

/** Creates a tmpdir mock pinta-codex package with required files. */
function makeAdaptorRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmgr-codex-restore-root-'));
  fs.mkdirSync(path.join(root, 'package', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package', 'dist', 'index.js'), '// pinta-codex entry');
  fs.writeFileSync(
    path.join(root, 'package', 'hooks.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CODEX_PLUGIN_ROOT}/dist/index.js' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node ${CODEX_PLUGIN_ROOT}/dist/index.js' }] }],
      },
    }),
  );
  return root;
}

function makeCtx(overrides: Partial<EnrollContext> = {}): EnrollContext {
  return {
    adaptorId: 'pinta-codex',
    adaptorVersion: '1.2.0',
    adaptorRoot: tmpAdaptorRoot,
    homeDir: tmpHome,
    platform: 'darwin',
    nodePath: process.execPath,
    resolveToken: testTokenResolver,
    backupRoot: tmpBackupRoot,
    // Restoration suite asserts legacy `codex_hooks = true` shape. Pin to pre-rename.
    hostVersion: '0.128.0',
    ...overrides,
  };
}

const install = {
  type: 'codex-plugin' as const,
  dist_root: 'package/dist',
  hooks_template: 'package/hooks.json',
  env_file_keys: {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'relay-endpoint' as const,
    OTEL_EXPORTER_OTLP_HEADERS: 'relay-token' as const,
  },
};

/** Calls applyCodexPlugin with a valid InstallContext using the module-scoped tmp dirs. */
async function runApply(
  homeDir: string = tmpHome,
  adaptorRoot: string = tmpAdaptorRoot,
): Promise<void> {
  await applyCodexPlugin(makeCtx({ homeDir, adaptorRoot }), install);
}

beforeEach(() => {
  tmpHome = makeTmpHome();
  tmpAdaptorRoot = makeAdaptorRoot();
  tmpBackupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pmgr-codex-restore-bak-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpAdaptorRoot, { recursive: true, force: true });
  fs.rmSync(tmpBackupRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hooks.json scenarios
// ---------------------------------------------------------------------------

describe('applyCodexPlugin – hooks.json restoration', () => {
  it('A: empty string content — restores manager hook entries', async () => {
    // User report scenario: hooks.json emptied to ""
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex', 'hooks.json'), '');

    await runApply();

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.SessionStart).toBeDefined();
    const cmds = hooks.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes('index.js'))).toBe(true);
  });

  it('B: empty JSON {} — restores manager hook entries', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex', 'hooks.json'), '{}');

    await runApply();

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.SessionStart).toBeDefined();
    const cmds = hooks.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes('index.js'))).toBe(true);
  });

  it('C: empty hooks key { "hooks": {} } — adds manager hook entries', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex', 'hooks.json'), JSON.stringify({ hooks: {} }));

    await runApply();

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.SessionStart).toBeDefined();
    expect(hooks.hooks.SessionStart.length).toBeGreaterThan(0);
  });

  it('D: file deleted — creates file with manager entries', async () => {
    // No .codex dir, no hooks.json
    await runApply();

    const hooksPath = path.join(tmpHome, '.codex', 'hooks.json');
    expect(fs.existsSync(hooksPath)).toBe(true);
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(hooks.hooks.SessionStart).toBeDefined();
    const cmds = hooks.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes(path.join(tmpAdaptorRoot, 'package', 'dist', 'index.js')))).toBe(true);
  });

  it('E: manager hook command modified — resets to canonical command', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    // Simulate user-edited (broken) manager command that still contains adaptorRoot
    const brokenManagerCmd = `node ${path.join(tmpAdaptorRoot, 'package', 'dist', 'WRONG.js')}`;
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: brokenManagerCmd }] }],
        },
      }),
    );

    await runApply();

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    const cmds = hooks.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    // Broken command removed, canonical command present
    expect(cmds.some((c: string) => c.includes('WRONG.js'))).toBe(false);
    expect(cmds.some((c: string) => c.includes(path.join(tmpAdaptorRoot, 'package', 'dist', 'index.js')))).toBe(true);
  });

  it('F: manager hook removed, user hooks preserved — user hooks remain + manager hooks added', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const userHookCmd = 'node /usr/local/bin/my-own-hook.js';
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: userHookCmd }] }],
        },
      }),
    );

    await runApply();

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    const cmds = hooks.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds).toContain(userHookCmd);
    expect(cmds.some((c: string) => c.includes('index.js'))).toBe(true);
  });

  it('G: malformed JSON — treats as missing, manager entries added', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'not valid json {{{');

    await runApply();

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.SessionStart).toBeDefined();
    const cmds = hooks.hooks.SessionStart.flatMap((m: any) => m.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes('index.js'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pinta-codex.env scenarios
// ---------------------------------------------------------------------------

describe('applyCodexPlugin – pinta-codex.env restoration', () => {
  it('H: empty file — adds manager OTEL_EXPORTER_OTLP_* keys', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex', 'pinta-codex.env'), '');

    await runApply();

    const env = fs.readFileSync(path.join(tmpHome, '.codex', 'pinta-codex.env'), 'utf-8');
    expect(env).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces');
    expect(env).toContain('OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=CODEX-TOKEN');
  });

  it('I: file deleted — creates file with manager keys', async () => {
    // No pinta-codex.env
    await runApply();

    const envPath = path.join(tmpHome, '.codex', 'pinta-codex.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const env = fs.readFileSync(envPath, 'utf-8');
    expect(env).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces');
    expect(env).toContain('OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=CODEX-TOKEN');
  });

  it('J: manager keys modified — resets to canonical resolved token', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'pinta-codex.env'),
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://wrong-host:9999\nOTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=STALE-TOKEN\n',
    );

    await runApply();

    const env = fs.readFileSync(path.join(tmpHome, '.codex', 'pinta-codex.env'), 'utf-8');
    expect(env).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces');
    expect(env).toContain('OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=CODEX-TOKEN');
    expect(env).not.toContain('wrong-host');
    expect(env).not.toContain('STALE-TOKEN');
    // No duplicate keys
    expect(env.match(/OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=/g)).toHaveLength(1);
    expect(env.match(/OTEL_EXPORTER_OTLP_HEADERS=/g)).toHaveLength(1);
  });

  it('K: user keys preserved alongside restored manager key', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'pinta-codex.env'),
      'MY_VAR=foo\nOTEL_EXPORTER_OTLP_TRACES_ENDPOINT=stale-value\n',
    );

    await runApply();

    const env = fs.readFileSync(path.join(tmpHome, '.codex', 'pinta-codex.env'), 'utf-8');
    expect(env).toContain('MY_VAR=foo');
    expect(env).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces');
    expect(env.match(/OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// config.toml scenarios
// ---------------------------------------------------------------------------

describe('applyCodexPlugin – config.toml restoration', () => {
  it('L: codex_hooks = false — flips to true', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      '[features]\ncodex_hooks = false\n',
    );

    await runApply();

    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/codex_hooks\s*=\s*true/);
    // No duplicate key
    const matches = toml.match(/codex_hooks\s*=/g);
    expect(matches).toHaveLength(1);
  });

  it('M: [features] section absent — adds [features] block with codex_hooks = true', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      '[history]\nmax_lines = 500\n',
    );

    await runApply();

    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[features]');
    expect(toml).toMatch(/codex_hooks\s*=\s*true/);
    // Existing section preserved
    expect(toml).toContain('[history]');
    expect(toml).toContain('max_lines = 500');
  });

  it('N: file deleted — creates file with [features].codex_hooks = true', async () => {
    await runApply();

    const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    const toml = fs.readFileSync(tomlPath, 'utf-8');
    expect(toml).toContain('[features]');
    expect(toml).toMatch(/codex_hooks\s*=\s*true/);
  });

  it('O: other config preserved — unrelated config intact after [features] added', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      '[model]\nname = "gpt-4"\n',
    );

    await runApply();

    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[model]');
    expect(toml).toContain('name = "gpt-4"');
    expect(toml).toContain('[features]');
    expect(toml).toMatch(/codex_hooks\s*=\s*true/);
  });

  it('P (modern): hooks = false — flips to true on next apply', async () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      '[features]\nhooks = false\n',
    );

    await applyCodexPlugin(makeCtx({ hostVersion: '0.129.0' }), install);

    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toMatch(/\bhooks\s*=\s*true/);
    expect(toml.match(/\bhooks\s*=/g)).toHaveLength(1);
  });

  it('Q (H8): codex-added [hooks.state.…] entries on unrelated paths are preserved across apply', async () => {
    // Simulates codex auto-writing a trust entry for the user's own hook
    // (different absolute path / event). Manager apply must not strip it.
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const userKey = '/some/other/hooks.json:user_event:0:0';
    const userHash = 'sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'config.toml'),
      `[features]\nhooks = true\n\n[hooks.state."${userKey}"]\ntrusted_hash = "${userHash}"\n`,
    );

    await applyCodexPlugin(makeCtx({ hostVersion: '0.129.0' }), install);

    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain(`[hooks.state."${userKey}"]`);
    expect(toml).toContain(`trusted_hash = "${userHash}"`);
  });
});
