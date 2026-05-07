import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';

describe('loadConfig — guardEndpoint resolution', () => {
  let tmpHome: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pinta-codex-cfg-'));
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    // Reset env keys we touch
    delete process.env.PINTA_GUARD_ENDPOINT;
    delete process.env.PINTA_RELAY_TOKEN;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.CLAUDE_PLUGIN_OPTION_API_KEY;
    delete process.env.CLAUDE_PLUGIN_OPTION_ENDPOINT;
    process.env.CODEX_HOME = path.join(tmpHome, '.codex');
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('reads PINTA_GUARD_ENDPOINT from pinta-codex.env when process.env is unset', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'pinta-codex.env'),
      [
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:5147/v1/traces',
        'OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=tok-from-file',
        'PINTA_GUARD_ENDPOINT=http://127.0.0.1:5147/guard/evaluate',
      ].join('\n'),
    );
    const cfg = loadConfig();
    expect(cfg.guardEndpoint).toBe('http://127.0.0.1:5147/guard/evaluate');
  });

  it('process.env.PINTA_GUARD_ENDPOINT takes precedence over envFile', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'pinta-codex.env'),
      'PINTA_GUARD_ENDPOINT=http://from-file/guard/evaluate',
    );
    process.env.PINTA_GUARD_ENDPOINT = 'http://from-env/guard/evaluate';
    const cfg = loadConfig();
    expect(cfg.guardEndpoint).toBe('http://from-env/guard/evaluate');
  });

  it('returns undefined when neither process.env nor envFile sets PINTA_GUARD_ENDPOINT', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'pinta-codex.env'),
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:5147/v1/traces',
    );
    const cfg = loadConfig();
    expect(cfg.guardEndpoint).toBeUndefined();
  });

  it('exposes PINTA_RELAY_TOKEN from envFile OTEL headers (existing behavior)', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'pinta-codex.env'),
      'OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=tok-xyz',
    );
    loadConfig();
    expect(process.env.PINTA_RELAY_TOKEN).toBe('tok-xyz');
  });
});
