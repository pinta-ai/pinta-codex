# Changelog

All notable changes to pinta-codex are documented here.

## [1.9.0] - 2026-09-20

### Changed

- The guard is asked about the span, not about a summary of it. Until now the
  `PreToolUse` gate assembled a five-field `GuardInput` (tool name, input, working
  directory, hook, session) beside the span that carried the same facts under
  `codex.*`, and the two were free to drift — `cwd` (PTA-176) and the hook name
  (PTA-207) were on the span and missing from the summary. Now the span is built
  first, `POST /guard/evaluate` receives that OTLP payload unwrapped, the manager
  projects it through the same AgentEvent assembly the backend stores it with,
  and the verdict is attached to the same object before it is relayed — the span
  the manager judged is the span the backend stores, `spanId` included.
  Requires Pinta Manager 0.1.11 or later; an older manager answers `400` and the
  gate fails open (`pinta.guard.fail_open_reason: error`), a newer manager that
  refuses a body answers `410`, recorded as `refused`.
- `@pinta-ai/core` `^0.6.0` → `^0.8.0` (`evaluateGuard(payload)`, `attachGuard`). Both gates (`PreToolUse`, `PermissionRequest`)
  send the same span shape; `evaluateToolGate` now takes the built payload.

## [1.8.0] - 2026-09-15

### Added

- **PermissionRequest gate.** Codex fires `PermissionRequest` wherever it would
  otherwise prompt the user — including network access, which `PreToolUse` never
  sees. It was unhandled, so that whole class of approval was unguarded.
  Its output envelope is **not** `PreToolUse`'s: the decision is nested as
  `hookSpecificOutput.decision = {behavior, message}` rather than the flat
  `permissionDecision` / `permissionDecisionReason` pair. Sending the flat shape
  parses as a valid envelope carrying no decision, so a deny is dropped with no
  diagnostic. Both shapes are now typed at the point of use.
- **All 12 hook events handled**, up from 5. Codex 0.154.0 dispatches
  `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`,
  `SubagentStop`, `Stop` and `Interrupt`. The seven that were previously
  discarded are now forwarded by a single generic observe handler, and
  `hooks.json` registers all twelve — an event handled in code but absent from
  that template is never dispatched.
- `tests/core/self-version.test.ts`, which fails when the embedded version
  constants drift from `package.json` (see Fixed).

### Changed

- `PreToolUse` and `PermissionRequest` now build their guard request through one
  shared `evaluateToolGate`, so the two gates cannot drift into different
  verdicts for the same action.
- Fail-open is now stated and tested as deliberate rather than left implicit. A
  guard endpoint that is unreachable or slow allows: an outage in Pinta must not
  stop an engineer from working.

### Fixed

- **Version misattribution.** `package.json` was 1.7.0 while `GUARD_UA`,
  `PLUGIN_VERSION` and `.codex-plugin/plugin.json` were all still 1.6.0, so
  every guard call and every OTLP span was attributed to a version that never
  shipped. Confirmed live: the sidecar logged
  `adaptor=pinta-codex ver=1.6.0` from an installation in `.../pinta-codex/1.7.0/`.
  `scripts/bump.mjs` sets all four in lock-step and exists precisely to prevent
  this; it had been bypassed.
- **`doctor` failed on a healthy install.** Codex renamed the feature flag from
  `codex_hooks` to `hooks`, and the check only recognised the old spelling — so
  a machine configured with `[features] hooks = true`, with hooks firing
  normally, was told its install was broken. Both spellings are now accepted.
- **`setup` wrote the deprecated flag name.** It now writes canonical
  `hooks = true`, and leaves an existing `codex_hooks = true` alone rather than
  adding a second key for one setting.
- Measured on codex-cli 0.154.0 with an isolated `CODEX_HOME`: `hooks` is stage
  `stable` and effective `true` with no config at all. Enabling it is now a
  no-op guard for older builds, and an absent key is no longer reported as a
  fault — only an explicit `false` is, since that is a silent kill switch.
- README corrected throughout: it claimed five events, `PreToolUse`/`PostToolUse`
  were "Bash tool only" (untrue since codex 0.134.0, which extended `PreToolUse`
  to `apply_patch`, MCP calls and every local function tool), and the feature
  flag was given as `features.codex_hooks`.

## [1.5.1] - 2026-07-20

### Changed

- `@pinta-ai/core` bumped `^0.3.0` → `^0.5.0` (devDependency, bundled
  into `dist/` at build). Pulls in the oversized-flush fix (pinta-manager#180
  follow-up): the retry queue now flushes in 900 KiB chunks instead of one
  unbounded POST, spans are capped at 800 KiB at build time, and a payload
  that alone exceeds the POST budget is dropped with a diagnostic instead of
  poisoning every later flush. No adaptor source change was needed.

## [1.4.0] - 2026-07-12

### Changed

- Low-level utilities consolidated into the shared private `@pinta-ai/core`
  package (`^0.3.0`, devDependency). `src/core/*` keeps thin adaptor bindings;
  core is **bundled + minified into `dist/` by esbuild at build time**, so npmjs
  consumers never need private-registry access and `dist/` carries no runtime
  `@pinta-ai/core` dependency.

### Added

- `pinta.client.rtt_ms` / `pinta.client.op` span attributes on PreToolUse spans.
  `buildOtlpPayload` already forwards its `guard` result into core's
  `buildPayload`, and core `0.3.0` derives the client-call timing from the
  `GuardResult.clientRttMs` it now measures. The manager can only time its own
  handler, so `clientRttMs - durationMs` gives it the transport overhead.

### Fixed

- `package-lock.json` resolved `@pinta-ai/core` as a `link:` to a local
  `../pinta-core` checkout. `npm ci` created a dangling symlink in CI and the
  build failed with `TS2307: Cannot find module '@pinta-ai/core'`. It is now
  pinned to core's GitHub Packages tarball URL + integrity hash.
- `publish` workflow: npm pinned to `11.18.0` (npm@latest is 12.x and requires
  node >=22.22, but the job runs node 20).
- `publish` workflow: restored OIDC trusted publishing. The committed `.npmrc`
  pointed npmjs auth at `${NPM_TOKEN}`, but no such secret exists — it expanded
  to an empty token and would have failed `npm publish` with ENEEDAUTH.
  `NODE_AUTH_TOKEN` is now scoped to the `npm ci` step alone.

## [1.2.1] - 2026-04-30

### Changed

- npm package name: `pinta-codex` → `@pinta-ai/pinta-codex` (consistent with `@pinta-ai/types`). git clone flow is unaffected — repository URL `awarecorp/pinta-codex` is unchanged.

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
