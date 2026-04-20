import { strict as assert } from 'node:assert';
import { buildOtlpPayload } from '../src/core/otlp.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    failures++;
    process.stdout.write(`  FAIL ${name}\n    ${err instanceof Error ? err.message : err}\n`);
  }
}

check('flattenEvent emits ingest.type=codex as first attribute', () => {
  const payload = buildOtlpPayload({
    event: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      transcript_path: '/tmp/t',
      cwd: '/home/u',
      prompt: 'hi',
    },
    traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    identity: { id: 'i1', email: 'u@x' },
    now: 1700000000000,
  });
  const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.equal(attrs[0].key, 'ingest.type', `expected first attr to be ingest.type, got ${attrs[0].key}`);
  assert.deepEqual(attrs[0].value, { stringValue: 'codex' });
  assert.equal(attrs[1].key, 'codex.hook', `expected second attr to be codex.hook, got ${attrs[1].key}`);
});

check('flattenEvent still emits codex.hook and other codex.* attrs', () => {
  const payload = buildOtlpPayload({
    event: {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      transcript_path: '/tmp/t',
      cwd: '/home/u',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu1',
    },
    traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    identity: { id: 'i1', email: 'u@x' },
    now: 1700000000000,
  });
  const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  const keys = attrs.map((a: { key: string }) => a.key);
  assert.ok(keys.includes('codex.hook'), `missing codex.hook; keys=${keys.join(',')}`);
  assert.ok(keys.includes('codex.tool_name'), `missing codex.tool_name; keys=${keys.join(',')}`);
  assert.ok(keys.includes('codex.tool_use_id'), `missing codex.tool_use_id; keys=${keys.join(',')}`);
});

if (failures > 0) {
  process.stdout.write(`\n${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write('\nOK\n');
