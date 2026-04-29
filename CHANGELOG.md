# Changelog

All notable changes to pinta-codex are documented here.

## [1.2.0] - 2026-04-29 (BREAKING)

### BREAKING CHANGES

- **Pinta CLI dependency removed** — `pinta identity id/email` is no longer invoked. Identity attribution moves to the relay layer (Pinta Manager attaches on forward; OSS users handle in their own pipeline).
- **`PINTA_CODEX_API_KEY` semantic changed** — was: Pinta backend API key sent as `x-api-key`. Now: optional, treated as a token wrapped into `OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=<value>`. New primary key is `OTEL_EXPORTER_OTLP_HEADERS` (full headers string in `key=val,key=val` format).
- **`PINTA_CODEX_ENDPOINT` deprecated (still accepted)** — new primary is `OTEL_EXPORTER_OTLP_ENDPOINT`. `npm run setup` auto-migrates legacy keys to OTel-spec naming (writes `~/.codex/pinta-codex.env.bak` first).
- **PreToolUse fail-close removed** — without identity to check, the deny path no longer fires. All hooks exit 0 on success.
- **`member.identity.*` resource attributes removed** — relay attaches identity if present.
- **`codex.client = "codex"` vestigial resource attribute removed.**
- **`src/enterprise/` directory removed** — `PintaIdentityResolver` deleted.
- **`src/handlers/auth-message.ts` removed** — no auth message to print.
- **`src/core/identity.ts` reduced to empty stub.**
- **`tools/setup.ts` no longer prompts for or checks Pinta identity** (step 5 dropped).
- **`tools/doctor.ts` no longer checks pinta CLI presence or identity authentication.**

### Added

- vitest test suite (`tests/core/otlp.test.ts`) — 5 tests covering OTLP builder + identity absence regression guards.
- `tools/_lib.ts`: `migrateLegacyEnvKeys(p)` — auto-rename legacy `PINTA_CODEX_*` keys to OTel-spec on next setup run, with `.bak` backup.
- `src/core/config.ts`: `hasOtlpEndpoint(config)` helper (currently unused — reserved for future signaling).
- `src/core/config.ts`: silent disable when no endpoint configured (was: `loadConfig()` threw).

### Changed

- `buildOtlpPayload` signature: `{event, traceId, identity, now?}` → `{event, traceId, now?}`.
- `Transport`: takes `PintaCodexConfig` (renamed from `PintaConfig`); reads `config.endpoint`/`config.headers` set by config resolution; silent-disable when endpoint missing.
- `package.json` description updated.
- `.codex-plugin/plugin.json` description + interface.shortDescription/longDescription updated for OTel collector framing.
- `tools/mock-server.ts` reduced to a generic OTLP collector + viewer (removed Pinta-backend-specific endpoints, auth gate, identity extraction).
- Hint messages in transport now reference `OTEL_EXPORTER_OTLP_*` env names.

### Migration

**Existing users with `~/.codex/pinta-codex.env`:** Just run `npm run setup` again. The migration helper detects legacy keys, writes a `.bak`, and renames in place. Then re-run `codex` — same plugin behavior, just with new env names.

**Manual config users:** Update `~/.codex/pinta-codex.env`:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector.example.com
OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=YOUR-TOKEN
```

(Or for non-Pinta collectors: `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer YOUR-TOKEN`.)

**Identity attribution:** v1.0/1.1's `member.identity.*` resource attrs are gone. If you depended on them in your pipeline, attach them at your collector / forwarder layer. Pinta Manager users (M9d+): manager handles this automatically.
