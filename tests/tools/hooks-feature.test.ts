import { describe, it, expect } from 'vitest';
import {
  ensureCodexHooksEnabled,
  isCodexHooksDisabled,
  isCodexHooksEnabled,
} from '../../tools/_lib.js';

/**
 * The hooks feature flag, which codex renamed and then stopped requiring.
 *
 * These helpers decided two user-visible things and got both wrong once codex
 * moved: `doctor` told people their install was broken, and `setup` wrote a
 * deprecated key into their config.
 *
 * Measured on codex-cli 0.154.0 with an isolated `CODEX_HOME`
 * (`codex features list`), which is where the expectations below come from:
 *
 *     [features] codex_hooks = true   →  hooks  stable  true
 *     [features] hooks = true         →  hooks  stable  true
 *     (no config.toml at all)         →  hooks  stable  true
 */

const CANONICAL = '[features]\nhooks = true\n';
const LEGACY = '[features]\ncodex_hooks = true\n';

describe('reading the hooks feature', () => {
  /**
   * The regression that shipped: this answered `false` for the canonical
   * spelling, so `doctor` failed on a machine whose hooks were firing.
   */
  it('recognises the canonical spelling', () => {
    expect(isCodexHooksEnabled(CANONICAL)).toBe(true);
  });

  it('still recognises the legacy alias codex accepts', () => {
    expect(isCodexHooksEnabled(LEGACY)).toBe(true);
  });

  it('reads an absent key as unset, not as disabled', () => {
    expect(isCodexHooksEnabled('[features]\nmemories = true\n')).toBe(false);
    expect(isCodexHooksDisabled('[features]\nmemories = true\n')).toBe(false);
  });

  it('separates an explicit false from an absent key', () => {
    // The one state worth failing on: a kill switch nothing else reports.
    expect(isCodexHooksDisabled('[features]\nhooks = false\n')).toBe(true);
    expect(isCodexHooksDisabled('[features]\ncodex_hooks = false\n')).toBe(true);
    expect(isCodexHooksEnabled('[features]\nhooks = false\n')).toBe(false);
  });

  it('does not match a key outside the features section', () => {
    expect(isCodexHooksEnabled('[other]\nhooks = true\n')).toBe(false);
  });
});

describe('writing the hooks feature', () => {
  it('writes the canonical key when nothing is set', () => {
    const { next, changed } = ensureCodexHooksEnabled('');
    expect(changed).toBe(true);
    expect(next).toContain('hooks = true');
    expect(next).not.toContain('codex_hooks');
  });

  it('adds the key to an existing features section without disturbing it', () => {
    const { next, changed } = ensureCodexHooksEnabled('[features]\nmemories = true\n');
    expect(changed).toBe(true);
    expect(next).toContain('memories = true');
    expect(isCodexHooksEnabled(next)).toBe(true);
  });

  it('is idempotent for both spellings', () => {
    expect(ensureCodexHooksEnabled(CANONICAL).changed).toBe(false);
    // Left alone rather than "upgraded": codex honours the alias, and writing
    // `hooks = true` beside it would leave two keys for one setting — so a
    // later `features disable hooks` would switch off the half the user can
    // see and none of the half that matters.
    expect(ensureCodexHooksEnabled(LEGACY).changed).toBe(false);
    expect(ensureCodexHooksEnabled(LEGACY).next).toBe(LEGACY);
  });

  it('flips an explicit false back to true', () => {
    const { next, changed } = ensureCodexHooksEnabled('[features]\nhooks = false\n');
    expect(changed).toBe(true);
    expect(isCodexHooksEnabled(next)).toBe(true);
    expect(isCodexHooksDisabled(next)).toBe(false);
  });

  it('preserves unrelated sections', () => {
    const before = '[features]\nhooks = true\n\n[hooks.state]\nfoo = "bar"\n';
    expect(ensureCodexHooksEnabled(before).next).toBe(before);
  });
});
