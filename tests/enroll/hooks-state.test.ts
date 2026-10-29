import { describe, it, expect } from 'vitest';
import {
  commandHookHash,
  buildHooksStateEntries,
  ensureCodexHooksStateEntries,
  nodePlatformToHookPlatform,
} from '../../src/enroll/hooks-state';

// Known canonical hashes from codex v0.129.0+ for the manager-installed
// pinta-codex command, taken from hook_trust_current_hash_report.md (which
// in turn matches codex's `command_hook_hash()` against a real user config).
const REPORT_COMMAND =
  'node /Users/pintaai/.pinta/adaptors/pinta-codex/1.2.4/package/dist/index.js';
const REPORT_HASHES: Record<string, string> = {
  SessionStart: 'sha256:4421aabf8e6599b85c1bea496492f68f3d5c9f7ae68657a7e8e349a4df00c398',
  UserPromptSubmit: 'sha256:74badb5498c56f7b394c7e09f9dee51137d76b173f79f55c11e1ccf717a40710',
  PreToolUse: 'sha256:56da915dcbeb5ae457e46f67621e67b72462cff761893e1587f8c77269c058cb',
  PostToolUse: 'sha256:ffb15a9d1d955103edb894eecf83a3834982139f690a24047825c8b7da04fced',
  Stop: 'sha256:1816a1ac962360a19b3448713edd29bcbca0abac73ce423099a5962ece61df1e',
};

describe('commandHookHash', () => {
  it.each(Object.entries(REPORT_HASHES))(
    'matches codex canonical hash for %s with default timeout / no matcher',
    (eventJsonKey, expected) => {
      const h = commandHookHash(
        eventJsonKey,
        undefined,
        { type: 'command', command: REPORT_COMMAND },
        'posix',
      );
      expect(h).toBe(expected);
    },
  );

  it('returns undefined for non-command handler types (e.g. prompt/agent)', () => {
    const h = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'prompt', command: 'echo hi' },
      'posix',
    );
    expect(h).toBeUndefined();
  });

  it('returns undefined when async: true (codex skips async hooks in trust)', () => {
    const h = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: 'echo hi', async: true },
      'posix',
    );
    expect(h).toBeUndefined();
  });

  it('returns undefined when command is empty after trim', () => {
    const h = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: '   ' },
      'posix',
    );
    expect(h).toBeUndefined();
  });

  it('returns undefined for unknown event JSON keys', () => {
    const h = commandHookHash(
      'SomethingMadeUp',
      undefined,
      { type: 'command', command: 'echo hi' },
      'posix',
    );
    expect(h).toBeUndefined();
  });

  it('omits matcher field for events that do not support it (UserPromptSubmit)', () => {
    // Same canonical identity whether or not the user passed a matcher string.
    const withMatcher = commandHookHash(
      'UserPromptSubmit',
      'Bash',
      { type: 'command', command: REPORT_COMMAND },
      'posix',
    );
    const withoutMatcher = commandHookHash(
      'UserPromptSubmit',
      undefined,
      { type: 'command', command: REPORT_COMMAND },
      'posix',
    );
    expect(withMatcher).toBe(REPORT_HASHES.UserPromptSubmit);
    expect(withoutMatcher).toBe(REPORT_HASHES.UserPromptSubmit);
  });

  it('includes matcher in identity when present on matcher-capable events', () => {
    const a = commandHookHash(
      'PreToolUse',
      'Bash',
      { type: 'command', command: REPORT_COMMAND },
      'posix',
    );
    const b = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: REPORT_COMMAND },
      'posix',
    );
    expect(a).not.toBe(b);
    expect(b).toBe(REPORT_HASHES.PreToolUse);
  });

  it('uses commandWindows on windows when present, else falls back to command', () => {
    const handler = {
      type: 'command' as const,
      command: 'unix-cmd',
      commandWindows: 'win-cmd',
    };
    const win = commandHookHash('PreToolUse', undefined, handler, 'windows');
    const posix = commandHookHash('PreToolUse', undefined, handler, 'posix');
    // Both produce a hash but with different command strings → different digests.
    expect(win).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(posix).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(win).not.toBe(posix);

    // Windows with no commandWindows falls back to plain command (= posix hash).
    const fallback = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: 'unix-cmd' },
      'windows',
    );
    expect(fallback).toBe(posix);
  });

  it('normalizes timeout: missing → 600, 0 → 1, positive → unchanged', () => {
    const def = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: 'x' },
      'posix',
    );
    const explicit600 = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: 'x', timeout: 600 },
      'posix',
    );
    const zero = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: 'x', timeout: 0 },
      'posix',
    );
    const one = commandHookHash(
      'PreToolUse',
      undefined,
      { type: 'command', command: 'x', timeout: 1 },
      'posix',
    );
    expect(def).toBe(explicit600);
    expect(zero).toBe(one);
  });
});

describe('nodePlatformToHookPlatform', () => {
  it('maps win32 → windows, anything else → posix', () => {
    expect(nodePlatformToHookPlatform('win32')).toBe('windows');
    expect(nodePlatformToHookPlatform('darwin')).toBe('posix');
    expect(nodePlatformToHookPlatform('linux')).toBe('posix');
  });
});

describe('buildHooksStateEntries', () => {
  const managerCmd = 'node /root/dist/index.js';
  const userCmd = 'node /usr/local/other.js';
  const merged = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: 'command' as const, command: userCmd },
            { type: 'command' as const, command: managerCmd },
          ],
        },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: 'command' as const, command: managerCmd }] },
      ],
    },
  };

  it('emits snake_case event labels in keys, only for manager-owned hooks', () => {
    const entries = buildHooksStateEntries(
      merged,
      '/home/u/.codex/hooks.json',
      (h) => h.command === managerCmd,
      'posix',
    );
    expect(entries).toEqual([
      {
        key: '/home/u/.codex/hooks.json:session_start:0:1',
        trustedHash: commandHookHash(
          'SessionStart',
          undefined,
          { type: 'command', command: managerCmd },
          'posix',
        ),
      },
      {
        key: '/home/u/.codex/hooks.json:user_prompt_submit:0:0',
        trustedHash: commandHookHash(
          'UserPromptSubmit',
          undefined,
          { type: 'command', command: managerCmd },
          'posix',
        ),
      },
    ]);
  });

  it('returns empty list when no manager hooks present', () => {
    const entries = buildHooksStateEntries(merged, '/p', () => false, 'posix');
    expect(entries).toEqual([]);
  });

  it('skips ineligible handlers (async / non-command / empty command)', () => {
    const m = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: 'command' as const, command: managerCmd, async: true },
              { type: 'prompt' as const, command: managerCmd },
              { type: 'command' as const, command: '   ' },
              { type: 'command' as const, command: managerCmd },
            ],
          },
        ],
      },
    };
    const entries = buildHooksStateEntries(m, '/p', () => true, 'posix');
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('/p:pre_tool_use:0:3');
  });

  it('skips unknown event JSON keys', () => {
    const m = {
      hooks: {
        TotallyUnknownEvent: [
          { hooks: [{ type: 'command' as const, command: managerCmd }] },
        ],
      },
    };
    expect(buildHooksStateEntries(m, '/p', () => true, 'posix')).toEqual([]);
  });
});

describe('ensureCodexHooksStateEntries', () => {
  it('no-ops on empty entries list', () => {
    const result = ensureCodexHooksStateEntries('[features]\nhooks = true\n', []);
    expect(result.changed).toBe(false);
    expect(result.next).toBe('[features]\nhooks = true\n');
  });

  it('appends new entries when sections are absent', () => {
    const result = ensureCodexHooksStateEntries('[features]\nhooks = true\n', [
      { key: '/p/hooks.json:pre_tool_use:0:0', trustedHash: 'sha256:aaa' },
    ]);
    expect(result.changed).toBe(true);
    expect(result.next).toContain('[hooks.state."/p/hooks.json:pre_tool_use:0:0"]');
    expect(result.next).toContain('trusted_hash = "sha256:aaa"');
  });

  it('replaces existing trusted_hash when value differs', () => {
    const input =
      '[hooks.state."/p/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:old"\n';
    const result = ensureCodexHooksStateEntries(input, [
      { key: '/p/hooks.json:pre_tool_use:0:0', trustedHash: 'sha256:new' },
    ]);
    expect(result.changed).toBe(true);
    expect(result.next).toContain('trusted_hash = "sha256:new"');
    expect(result.next).not.toContain('sha256:old');
  });

  it('reports no change when desired entry already matches', () => {
    const input =
      '[hooks.state."/p/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n';
    const result = ensureCodexHooksStateEntries(input, [
      { key: '/p/hooks.json:pre_tool_use:0:0', trustedHash: 'sha256:abc' },
    ]);
    expect(result.changed).toBe(false);
  });

  it('leaves unrelated [hooks.state.…] sections intact (H8 invariant)', () => {
    const input =
      '[hooks.state."/other/hooks.json:user_evt:0:0"]\ntrusted_hash = "sha256:user"\n';
    const result = ensureCodexHooksStateEntries(input, [
      { key: '/p/hooks.json:pre_tool_use:0:0', trustedHash: 'sha256:mgr' },
    ]);
    expect(result.next).toContain('[hooks.state."/other/hooks.json:user_evt:0:0"]');
    expect(result.next).toContain('trusted_hash = "sha256:user"');
    expect(result.next).toContain('trusted_hash = "sha256:mgr"');
  });

  describe('prune', () => {
    it('removes a managed-path entry whose position no longer exists', () => {
      const input =
        '[features]\nhooks = true\n\n' +
        '[hooks.state."/p/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:keep"\n\n' +
        '[hooks.state."/p/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:gone"\n';
      const result = ensureCodexHooksStateEntries(
        input,
        [{ key: '/p/hooks.json:pre_tool_use:0:0', trustedHash: 'sha256:keep' }],
        { managedPath: '/p/hooks.json', validKeys: ['/p/hooks.json:pre_tool_use:0:0'] },
      );
      expect(result.changed).toBe(true);
      expect(result.next).toContain('[hooks.state."/p/hooks.json:pre_tool_use:0:0"]');
      expect(result.next).not.toContain('post_tool_use');
      expect(result.next).not.toContain('sha256:gone');
      // unrelated section + trailing entry survive intact
      expect(result.next).toContain('[features]');
    });

    it('keeps managed-path entries that are still valid (e.g. user hooks)', () => {
      const input =
        '[hooks.state."/p/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:mgr"\n\n' +
        '[hooks.state."/p/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:userhook"\n';
      const result = ensureCodexHooksStateEntries(input, [], {
        managedPath: '/p/hooks.json',
        validKeys: ['/p/hooks.json:pre_tool_use:0:0', '/p/hooks.json:stop:0:0'],
      });
      expect(result.changed).toBe(false);
      expect(result.next).toBe(input);
    });

    it('never prunes entries for other hooks.json files', () => {
      const input =
        '[hooks.state."/other/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:other"\n';
      const result = ensureCodexHooksStateEntries(input, [], {
        managedPath: '/p/hooks.json',
        validKeys: [],
      });
      expect(result.changed).toBe(false);
      expect(result.next).toContain('[hooks.state."/other/hooks.json:pre_tool_use:0:0"]');
    });

    it('prunes all managed entries when validKeys is empty (uninstall)', () => {
      const input =
        '[features]\nhooks = true\n\n' +
        '[hooks.state."/p/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:a"\n\n' +
        '[hooks.state."/p/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:b"\n';
      const result = ensureCodexHooksStateEntries(input, [], {
        managedPath: '/p/hooks.json',
        validKeys: [],
      });
      expect(result.changed).toBe(true);
      expect(result.next).not.toContain('hooks.state');
      expect(result.next).toContain('[features]');
    });

    it('upserts then prunes in one pass: shifts index 0:1 -> 0:0', () => {
      const input =
        '[hooks.state."/p/hooks.json:pre_tool_use:0:1"]\ntrusted_hash = "sha256:old"\n';
      const result = ensureCodexHooksStateEntries(
        input,
        [{ key: '/p/hooks.json:pre_tool_use:0:0', trustedHash: 'sha256:new' }],
        { managedPath: '/p/hooks.json', validKeys: ['/p/hooks.json:pre_tool_use:0:0'] },
      );
      expect(result.changed).toBe(true);
      expect(result.next).toContain('[hooks.state."/p/hooks.json:pre_tool_use:0:0"]');
      expect(result.next).toContain('sha256:new');
      expect(result.next).not.toContain(':0:1');
      expect(result.next).not.toContain('sha256:old');
    });
  });
});
