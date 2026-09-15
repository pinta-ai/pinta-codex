import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `service.version` used to be the literal string "unknown" on every codex span,
 * because the only source read was `CODEX_CLI_VERSION` and codex does not set
 * it. That was established by dumping the full environment of a real hook child
 * (codex 0.154.0, `codex exec`): 69 variables, of which the codex-owned ones
 * were `CODEX_HOME`, `CODEX_MANAGED_BY_NPM` and `CODEX_MANAGED_PACKAGE_ROOT`.
 * The hook payload carried no version either.
 *
 * These tests pin the two sources that do exist, and the order between them.
 * The fixtures reproduce the shapes as measured, not as imagined:
 *
 *  - the transcript's first record, `{"type":"session_meta","payload":{…,
 *    "cli_version":"0.154.0",…}}`
 *  - `CODEX_MANAGED_PACKAGE_ROOT` pointing at a directory whose package.json
 *    carries the same version
 *
 * The cache in otlp.ts is module-level (hooks are one-shot processes, so a
 * process-lifetime cache is correct there). Tests therefore re-import the
 * module per case instead of exporting a reset hook that production never uses.
 */

const MEASURED_VERSION = '0.154.0';

// Only the codex-owned variables observed in the real hook child. Tests start
// from this set so that "no version anywhere" is a faithful baseline rather
// than an empty environment that could never occur.
const MEASURED_CODEX_ENV = {
  CODEX_HOME: '/tmp/codex-home',
  CODEX_MANAGED_BY_NPM: '1',
};

let tmp: string;

async function freshBuild() {
  vi.resetModules();
  const mod = await import('../../src/core/otlp');
  return mod.buildOtlpPayload;
}

function versionOf(payload: any): string | undefined {
  const attrs = payload.resourceSpans[0].resource.attributes;
  return attrs.find((a: any) => a.key === 'service.version')?.value?.stringValue;
}

async function resolve(transcriptPath: string): Promise<string | undefined> {
  const buildOtlpPayload = await freshBuild();
  return versionOf(
    buildOtlpPayload({
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        transcript_path: transcriptPath,
        cwd: '/tmp',
      } as any,
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    }),
  );
}

function writeTranscript(name: string, firstRecord: unknown, trailingNewline = true): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(firstRecord) + (trailingNewline ? '\n' : ''));
  return p;
}

function writePackageRoot(version: string): string {
  const root = path.join(tmp, `pkg-${version}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version }),
  );
  return root;
}

const sessionMeta = (version: string) => ({
  timestamp: '2026-09-15T02:40:02.492Z',
  ordinal: 0,
  type: 'session_meta',
  payload: {
    session_id: '01a0a2ef-894f-7580-9b9b-66155e3aa7cf',
    cwd: '/tmp',
    originator: 'codex_exec',
    cli_version: version,
    source: 'exec',
  },
});

describe('codex CLI version resolution', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-version-test-'));
    for (const k of ['CODEX_CLI_VERSION', 'CODEX_MANAGED_PACKAGE_ROOT']) {
      vi.stubEnv(k, undefined as unknown as string);
    }
    for (const [k, v] of Object.entries(MEASURED_CODEX_ENV)) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads cli_version from the transcript session_meta record', async () => {
    const t = writeTranscript('rollout.jsonl', sessionMeta(MEASURED_VERSION));
    expect(await resolve(t)).toBe(MEASURED_VERSION);
  });

  it('is not "unknown" under the environment a real codex hook actually gets', async () => {
    // The regression this whole change exists for.
    const t = writeTranscript('rollout.jsonl', sessionMeta(MEASURED_VERSION));
    expect(await resolve(t)).not.toBe('unknown');
  });

  it('ignores a first record that is not session_meta', async () => {
    const t = writeTranscript('rollout.jsonl', {
      type: 'event_msg',
      payload: { cli_version: '9.9.9' },
    });
    expect(await resolve(t)).toBe('unknown');
  });

  it('falls back to CODEX_MANAGED_PACKAGE_ROOT when the transcript is absent', async () => {
    vi.stubEnv('CODEX_MANAGED_PACKAGE_ROOT', writePackageRoot(MEASURED_VERSION));
    expect(await resolve(path.join(tmp, 'does-not-exist.jsonl'))).toBe(MEASURED_VERSION);
  });

  it('prefers the transcript over CODEX_MANAGED_PACKAGE_ROOT', async () => {
    // Both exist and disagree: the transcript is codex reporting its own
    // version for this session, the package root only describes what npm
    // installed, so the transcript wins.
    vi.stubEnv('CODEX_MANAGED_PACKAGE_ROOT', writePackageRoot('0.1.0'));
    const t = writeTranscript('rollout.jsonl', sessionMeta(MEASURED_VERSION));
    expect(await resolve(t)).toBe(MEASURED_VERSION);
  });

  it('falls back to CODEX_CLI_VERSION last, if codex ever starts setting it', async () => {
    vi.stubEnv('CODEX_CLI_VERSION', '1.2.3');
    expect(await resolve(path.join(tmp, 'does-not-exist.jsonl'))).toBe('1.2.3');
  });

  it('returns "unknown" when no source carries a version', async () => {
    expect(await resolve(path.join(tmp, 'does-not-exist.jsonl'))).toBe('unknown');
  });

  it('gives up rather than reading an unbounded first line', async () => {
    // A first line past the read bound must not be chased: hooks are on the
    // latency path. cli_version sits early in the line, so this only passes if
    // the bound is real and the newline search is what gates the parse.
    const huge = sessionMeta(MEASURED_VERSION) as any;
    huge.payload.base_instructions = 'x'.repeat(300 * 1024);
    const t = writeTranscript('rollout.jsonl', huge);
    expect(await resolve(t)).toBe('unknown');
  });

  it('gives up on a transcript whose first line has no terminator yet', async () => {
    // A session still being written: the record may be partially flushed.
    const t = writeTranscript('rollout.jsonl', sessionMeta(MEASURED_VERSION), false);
    expect(await resolve(t)).toBe('unknown');
  });

  it('survives a corrupt transcript', async () => {
    const p = path.join(tmp, 'corrupt.jsonl');
    fs.writeFileSync(p, 'not json at all\n');
    expect(await resolve(p)).toBe('unknown');
  });

  it('survives CODEX_MANAGED_PACKAGE_ROOT pointing nowhere', async () => {
    vi.stubEnv('CODEX_MANAGED_PACKAGE_ROOT', path.join(tmp, 'nope'));
    expect(await resolve(path.join(tmp, 'does-not-exist.jsonl'))).toBe('unknown');
  });
});
