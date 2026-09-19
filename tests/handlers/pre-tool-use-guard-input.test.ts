import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/handlers/emit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/handlers/emit.js')>()),
  sendPayload: vi.fn(),
}));

import { handlePreToolUse } from '../../src/handlers/pre-tool-use.js';
import type { PintaCodexConfig } from '../../src/core/config.js';
import type { PreToolUseEvent } from '../../src/core/types.js';

/**
 * The guard is asked about the span the gate is about to relay.
 *
 * It used to get a hand-picked summary of the event, and the summary drifted:
 * `cwd` — which locates a relative target, `rm -rf passwd` reads as routine
 * work until you know it was issued from /etc (PTA-176) — and the hook name —
 * what lets the manager trust `tool_name` at all (PTA-207) — were on the span
 * and not in the summary. Now there is one reading, and the manager projects
 * it through the same AgentEvent assembly the backend stores it with.
 *
 * Asserted on the POST body rather than on a mocked `evaluateGuard`, so the
 * whole chain — handler, the codex binding, and @pinta-ai/core — has to carry
 * the span for this to pass.
 */
describe('handlePreToolUse — what the guard is told about the invocation', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('puts the span — working directory and event included — on the wire, unwrapped', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ decision: 'ALLOW', reason: null, durationMs: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    globalThis.fetch = fetchMock as never;

    await handlePreToolUse(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf passwd' },
        cwd: '/etc',
      } as PreToolUseEvent,
      { guardEndpoint: 'http://127.0.0.1:5147/guard/evaluate' } as PintaCodexConfig,
    );

    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect('input' in sent).toBe(false);
    const attrs = Object.fromEntries(
      sent.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: any) => [a.key, a.value.stringValue]),
    );
    expect(attrs).toMatchObject({ 'ingest.type': 'codex', 'codex.cwd': '/etc', 'codex.hook': 'PreToolUse', 'codex.tool_name': 'Bash' });
  });
});
