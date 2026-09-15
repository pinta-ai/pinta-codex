import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOCKING_HOOKS,
  OBSERVE_HOOKS,
  isSkippedHook,
} from '../../src/core/types.js';
import type { BaseEvent } from '../../src/core/types.js';

/**
 * The adaptor used to know five of codex's twelve hook events and discard the
 * other seven by name. That was not a gap in codex: `HOOK_EVENT_NAMES` in
 * `codex-rs/hooks/src/lib.rs` has carried twelve for some time, and the same
 * twelve are readable out of the shipped binary as one `<event>.command.input`
 * JSON schema apiece (transcribed here from codex-cli 0.154.0).
 *
 * The list below is therefore a transcription of an external contract, not a
 * preference. It is spelled out literally rather than derived from the source
 * under test, so that dropping an event from `types.ts` fails here instead of
 * quietly shrinking both sides together.
 */
const CODEX_0_154_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const;

const asEvent = (name: string): BaseEvent =>
  ({ hook_event_name: name, session_id: 's', transcript_path: '/tmp/t', cwd: '/tmp' }) as BaseEvent;

describe('codex hook event inventory', () => {
  it('recognises every event codex 0.154.0 dispatches', () => {
    const known = [...BLOCKING_HOOKS, ...OBSERVE_HOOKS];
    expect([...known].sort()).toEqual([...CODEX_0_154_EVENTS].sort());
  });

  it('treats no known event as skippable', () => {
    for (const name of CODEX_0_154_EVENTS) {
      expect(isSkippedHook(asEvent(name)), name).toBe(false);
    }
  });

  it('stays fail-open on a thirteenth event from a future codex release', () => {
    // A codex release that adds an event must degrade to "exit 0, do nothing",
    // never to a crash — the hook sits on the tool-dispatch path.
    expect(isSkippedHook(asEvent('SomeFutureEvent'))).toBe(true);
  });

  it('classifies only the two tool-bearing gates as blocking', () => {
    // Widening this set is a security-relevant change: it claims an event's
    // stdout can refuse a tool call. Only these two can, and only PreToolUse
    // fires under --full-auto / approval_policy = "never".
    expect([...BLOCKING_HOOKS]).toEqual(['PreToolUse', 'PermissionRequest']);
  });

  it('keeps blocking and observe disjoint', () => {
    const overlap = [...BLOCKING_HOOKS].filter((e) => (OBSERVE_HOOKS as readonly string[]).includes(e));
    expect(overlap).toEqual([]);
  });
});

describe('hooks.json template', () => {
  // This template is what pinta-manager installs verbatim into ~/.codex/hooks.json
  // (`resolveHooksTemplate` substitutes ${CODEX_PLUGIN_ROOT} and merges it in).
  // An event the adaptor handles but the template omits is never dispatched at
  // all, so the handler would be unreachable in production while every unit
  // test still passed.
  const template = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'hooks.json'), 'utf8'),
  ) as { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> };

  it('registers every event the adaptor handles', () => {
    expect(Object.keys(template.hooks).sort()).toEqual([...CODEX_0_154_EVENTS].sort());
  });

  it('points every event at the adaptor entry point', () => {
    for (const [event, matchers] of Object.entries(template.hooks)) {
      expect(matchers.length, event).toBe(1);
      expect(matchers[0].hooks.length, event).toBe(1);
      expect(matchers[0].hooks[0].type, event).toBe('command');
      expect(matchers[0].hooks[0].command, event).toBe(
        'node ${CODEX_PLUGIN_ROOT}/dist/index.js',
      );
    }
  });

  it('registers no matcher on any event', () => {
    // An absent matcher matches every tool. This is why the adaptor already
    // receives apply_patch and MCP payloads on PreToolUse without opting in,
    // and why adding a matcher would silently narrow coverage.
    for (const [event, matchers] of Object.entries(template.hooks)) {
      for (const m of matchers) {
        expect(m, event).not.toHaveProperty('matcher');
      }
    }
  });
});
