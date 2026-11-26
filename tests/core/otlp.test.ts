import { attachGuard } from '@pinta-ai/core';
import { describe, it, expect } from 'vitest';
import { buildOtlpPayload } from '../../src/core/otlp';

describe('buildOtlpPayload (v1.2.0 — generic)', () => {
  it('separates returned secrets from completed inputs', () => {
    const inputKey = `sk-${'FAKE0'.repeat(9)}input`;
    const outputKey = `sk-${'FAKE0'.repeat(9)}output`;
    const payload = buildOtlpPayload({
      event: {
        hook_event_name: 'PostToolUse', session_id: 'credential-scope',
        tool_name: 'Read', tool_input: { note: inputKey }, tool_response: { stdout: outputKey },
      },
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    });
    const encoded = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((a) => a.key === 'pinta.facts');
    const facts = JSON.parse(String(Object.values(encoded?.value ?? {})[0]));
    expect(facts.items).toMatchObject([
      { secrets: { count: 1, origins: ['attributes'] } },
      { secrets: { count: 1, origins: ['toolOutput'] } },
    ]);
    expect(JSON.stringify(payload)).not.toContain(inputKey);
    expect(JSON.stringify(payload)).not.toContain(outputKey);
  });

  it('produces resourceSpans with one span per call', () => {
    const payload = buildOtlpPayload({
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'sess-123',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
      } as any,
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    });
    expect(payload.resourceSpans).toHaveLength(1);
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('codex.session_start');
  });

  it('flattens hook event fields into codex.* attributes', () => {
    const payload = buildOtlpPayload({
      event: {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/t',
        cwd: '/t',
        tool_name: 'Bash',
      } as any,
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    });
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const hook = attrs.find((a: any) => a.key === 'codex.hook');
    expect((hook?.value as any)?.stringValue).toBe('PreToolUse');
  });

  it('does NOT include member.identity.* in resource attributes', () => {
    const payload = buildOtlpPayload({
      event: { hook_event_name: 'Stop', session_id: 's', transcript_path: '/t', cwd: '/t' } as any,
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    });
    const resourceAttrs = payload.resourceSpans[0].resource.attributes;
    expect(resourceAttrs.find((a: any) => a.key === 'member.identity.id')).toBeUndefined();
    expect(resourceAttrs.find((a: any) => a.key === 'member.identity.email')).toBeUndefined();
  });

  it('does NOT include codex.client vestigial attribute', () => {
    const payload = buildOtlpPayload({
      event: { hook_event_name: 'SessionStart', session_id: 's', transcript_path: '/t', cwd: '/t' } as any,
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    });
    const resourceAttrs = payload.resourceSpans[0].resource.attributes;
    expect(resourceAttrs.find((a: any) => a.key === 'codex.client')).toBeUndefined();
  });

  it('reports service.name = codex', () => {
    const payload = buildOtlpPayload({
      event: { hook_event_name: 'SessionStart', session_id: 's', transcript_path: '/t', cwd: '/t' } as any,
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    });
    const resourceAttrs = payload.resourceSpans[0].resource.attributes;
    const sn = resourceAttrs.find((a: any) => a.key === 'service.name');
    expect((sn?.value as any)?.stringValue).toBe('codex');
  });

  it('carries no pinta.guard.* itself; the verdict is attached to the same span afterwards', () => {
    const payload = buildOtlpPayload({
      event: {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/t',
        cwd: '/t',
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: 'u1',
      } as any,
      traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    });
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes.some((a: any) => a.key.startsWith('pinta.guard.'))).toBe(false);
    attachGuard(payload, { decision: 'DENY', reason: 'deny_credentials', userMessage: null, durationMs: 8 });
    const decision = span.attributes.find((a: any) => a.key === 'pinta.guard.decision');
    const rule = span.attributes.find((a: any) => a.key === 'pinta.guard.matched_rule');
    const dur = span.attributes.find((a: any) => a.key === 'pinta.guard.duration_ms');
    expect((decision?.value as any)?.stringValue).toBe('deny');
    expect((rule?.value as any)?.stringValue).toBe('deny_credentials');
    expect((dur?.value as any)?.intValue).toBe(8);
  });
});
