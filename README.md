# pinta-codex

Guard and OTLP forwarder for Codex hook events. Blocks dangerous tool calls
before they run, and forwards every hook event as a span.

> **End-user install guide:** [`docs/installation-guide.md`](./docs/installation-guide.md)
> **Differences from pinta-cc:** [`docs/codex-vs-claude-code.md`](./docs/codex-vs-claude-code.md)
> This README is a developer-oriented overview.

## Channels

Two channels are operated in parallel. They coexist on the same machine because each entry in `~/.codex/hooks.json` is discriminated by its absolute-path prefix.

| Channel | Audience | Install |
|---------|----------|---------|
| **Pinta Manager** (v0.2+) | Pinta users | The catalog installs the npm tarball and registers a `hooks.json` entry under the manager root prefix automatically. **No manual setup required.** |
| **Git clone + npm run setup** | OSS / standalone | See Quick start below. Endpoint/token are written directly to `~/.codex/pinta-codex.env`. |

## Quick start (OSS / standalone)

```bash
git clone https://github.com/awarecorp/pinta-codex.git
cd pinta-codex
npm install
npm run setup      # interactive: build + env (OTLP collector URL) + config.toml + hooks.json
codex              # hooks fire immediately
npm run doctor     # verify everything green
```

`setup` is idempotent — re-running it is safe. `doctor` is read-only.

## What it captures

Codex 0.154.0 dispatches **twelve** hook events. All twelve are handled: two
pre-execution gates, one output gate, and nine observations.

Hooks require the `hooks` feature in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

> `codex_hooks` is the pre-0.13x spelling. Codex still accepts it as a legacy
> alias, but `hooks` is the canonical name and the one to write.

### Gates — these can deny

| Event | Notes |
|-------|-------|
| `PreToolUse` | Local calls which dispatch this hook, including Bash, `apply_patch` and MCP; not every host tool path |
| `PermissionRequest` | Fires when Codex would prompt the user, including for network access |

Both answer through stdout, and their output envelopes are **not the same
shape** — see `src/core/types.ts`. A deny must carry a non-empty reason; Codex
rejects one without it. `PreToolUse` accepts only `deny` (an allow is empty
stdout).
Hosted tools, `write_stdin` and specialized paths that omit these hooks remain
outside adapter coverage.

### Observed — forwarded, never block

`PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`,
`UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

`SessionStart` also drains the retry queue; `UserPromptSubmit` starts a new ULID
trace per user turn; `Stop` performs the final flush. `SessionEnd` is
send-only — Codex reads no reply from it.

Each invocation spawns `node dist/index.js`, maps the event to a single OTLP span, and POSTs it to `{endpoint}/traces`.

### Output gate — does not undo execution

`PostToolUse` submits the original `tool_response`, input and event identity to
the guard, including non-zero Bash exits when the host dispatches this event. On DENY it
returns **`{"decision":"block","reason":"…"}`**, the native
[Codex 0.154.0 contract](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/hooks/src/events/post_tool_use.rs).
Codex substitutes that feedback for the original result; it may continue the
turn. This is not a pre-tool refusal or rollback of completed side effects.
Hosted tools and paths which do not dispatch local hooks remain outside coverage.
In a native Codex 0.154.0 loopback-provider test, successful MCP results dispatched
this hook, but MCP `isError: true` results reached the model **without a
`PostToolUse` event**. Those error results remain outside this adapter's output
gate (PTA-596); a handler-only fixture cannot prove native error coverage.

Output decisions carry `pinta.guard.target=tool_output` on the original masked
span. The manager/runtime must interpret the native post phase as output
evaluation, not re-run execution policies against completed operations.

For **all three gates**, a decided DENY queues its span on disk and finishes
without an OTLP/retry network wait. A later non-denied/lifecycle hook drains the
existing retry queue. Delivery remains best-effort: a denied invocation alone
does not prove collector ingestion.

## Behavior

- OTLP/HTTP JSON transport. Headers are read from `OTEL_EXPORTER_OTLP_HEADERS` (`key=val,key=val` format)
- Top-level event fields are flattened into `codex.*` span attributes (Bronze; sibling adaptors use `cc.*`, `mcp.*`)
- **Telemetry is best-effort.** Every hook exits 0. A decided DENY travels in stdout and queues its span without awaiting a network request; other hooks retain normal send/retry behavior
- **Fail-open is deliberate.** If the guard endpoint is unreachable or slow, the gates allow. An outage in Pinta must not stop an engineer from working; the guard is a control, not a dependency
- Disk-backed retry queue at `.plugin-data/failed-spans.jsonl` (cap 1000). Drained on a later non-denied or lifecycle hook invocation
- One trace per user turn — based on the `UserPromptSubmit` ULID

### Model attribution and its limits

`codex.model` is the exact host-reported scalar model ID. An explicit hook
`model` wins, accepting a string or a descriptor's `id` (or `name` when no `id`
field exists), rather than stringifying the descriptor. Its
`codex.model_source` preserves the host's supplied source or defaults to
`hook.model`; a hook model can describe a requested
selection and is not by itself proof of a provider's routed response.

JSON-stringified objects/arrays (including `[object Object]`) are not IDs.
Provider and requested/response fields remain unchanged. If a transcript
replaces an unusable model, `model_source` describes that transcript evidence;
a previous host source is retained as `codex.model_original_source`.

When the hook has no usable model, `transcript.turn_context` evidence is
available only with an exact `session_meta.payload.id == session_id` and
`turn_context.payload.turn_id == turn_id` in the supplied rollout JSONL.
`turn_context.payload.model` becomes `codex.model`, with
`codex.model_source=transcript.turn_context`. **This is the requested turn
model, not a claim about response routing.** Only records at/before the hook
timestamp (or processing time when absent) qualify. Conflicting same-turn
models are omitted rather than choosing the latest.

There is no session-wide carry-forward: an older/different turn, another
session, or a parent's context for `SubagentStart`/`SubagentStop` cannot supply
the model. Older rollouts without `turn_id`, missing/late-flushed context,
context outside the read window, and uncorrelated events remain model-less.
A child session needs its own matching rollout and turn. Global configuration,
provider names, CLI versions, process names and user prose are never model
evidence.

Blank, `unknown`, `undefined`, `null`, `n/a`, `none`, `auto` and `default`
are omissions (case-insensitive), as are non-ID objects, control characters and
IDs longer than 512 characters. No mandatory event fields are added.
The original input, other flattened fields, guard behavior, event count and
redaction pipeline are unchanged.

Model lookup opens only the supplied absolute `.jsonl` regular file, read-only,
with no subprocess, directory scan or model cache. It reads at most a 256 KiB
header plus a 1 MiB tail and 4,096 complete records. Missing/unreadable files,
leaf symlinks, malformed records and invalid identities fail quietly;
incomplete boundary lines are ignored. It never logs or exports transcript
contents. An explicit model or missing turn ID needs no model-lookup IO.

## Configuration

`npm run setup` writes the endpoint and headers to `~/.codex/pinta-codex.env`. Environment variables override file values.

```bash
# OTel-spec (primary)
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-collector.example.com"
export OTEL_EXPORTER_OTLP_HEADERS="x-pinta-relay-token=YOUR-TOKEN"

# Non-Pinta collectors
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR-TOKEN"
```

Example `~/.codex/pinta-codex.env`:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector.example.com
OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=YOUR-TOKEN
```

**Resolution precedence (highest to lowest):**
1. Explicit `process.env` (`OTEL_EXPORTER_OTLP_*`)
2. `~/.codex/pinta-codex.env` (managed by `npm run setup`)
3. Legacy `PINTA_CODEX_*` keys (auto-migrated on next `npm run setup`)
4. Parity keys (`CLAUDE_PLUGIN_OPTION_ENDPOINT` / `CLAUDE_PLUGIN_OPTION_API_KEY`)

Optional overrides:

```bash
export CODEX_PLUGIN_DATA="/abs/path/to/.plugin-data"     # override runtime data dir
export CODEX_CLI_VERSION="$(codex --version | awk '{print $NF}')"
export CODEX_HOME="/abs/path/to/.codex"                  # override ~/.codex during install
```

## Identity — not needed

Since v1.2 the Pinta CLI dependency has been removed. Identity attachment is the responsibility of the relay layer. Pinta Manager attaches it on forward, and OSS users handle it in their own pipeline. The plugin itself runs without identity, and no hook is blocked by its absence.

## Manual install (advanced)

If you don't want to use the interactive setup:

```bash
npm run build
npm run install-hooks                  # merges absolute paths into ~/.codex/hooks.json
npm run install-hooks -- --dry-run     # preview without writing
```

`install-hooks` is idempotent: if `~/.codex/hooks.json` already matches the bundled template, it's a no-op (`already up to date`). Stale pinta-codex entries from previous paths are detected and removed automatically (`removed N stale pinta-codex entries`).

Add the following manually to `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

> **Why an install script?** Codex does not yet auto-load hooks from `.codex-plugin/plugin.json`. `install-hooks` substitutes `${CODEX_PLUGIN_ROOT}` in the bundled `hooks.json` template with an absolute path and merges it into the user-level file. Once Codex adds plugin-hook auto-discovery, this step will go away.

## Uninstall

```bash
npm run uninstall-hooks
```

This removes only this plugin's entries from `~/.codex/hooks.json` (those referencing `dist/index.js`). Other hooks are left untouched.

For a complete removal:

```bash
rm ~/.codex/pinta-codex.env
# Manually remove the [features] hooks = true line from ~/.codex/config.toml
```

## Local development

Mock server (OTLP viewer at `http://localhost:3000`):

```bash
npm run mock-server
```

In another terminal, point the endpoint at the mock and start Codex:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000 codex
```

Or set up via stdin pipe:

```bash
printf 'http://localhost:3000\n\n' | npm run setup
```

## Scripts

`npm run smoke:model` (after `npm run build`) tests the actual CJS and ESM hooks
against a loopback OTLP collector with isolated HOME/plugin data and no
manager/guard calls. It covers supplied, missing, placeholder, correlated,
cross-session/subagent, future, partial and oversized transcript cases and
writes `.validation/model-smoke.json`. Optionally pass
`-- --baseline=<previous-built-index.js>` for paired wall-time comparisons;
these include Node startup, local HTTP and scheduler noise.

| Script | Purpose |
|--------|---------|
| `npm run setup` | one-shot interactive installer (build + env + config + hooks) |
| `npm run doctor` | read-only health check; exits 1 on failure |
| `npm test` | vitest test suite |
| `npm run build` | `tsc` into `dist/` |
| `npm run dev` | `tsc --watch` |
| `npm run install-hooks` | merge entries into `~/.codex/hooks.json` (supports `-- --dry-run`) |
| `npm run uninstall-hooks` | remove this plugin's entries from `~/.codex/hooks.json` |
| `npm run mock-server` | local OTLP collector for testing |
| `npm run test:otlp` | span-flattening unit checks (legacy assert-based) |
| `npm run test:redact` | redaction unit checks (legacy assert-based) |

## BREAKING CHANGES from 1.0.x / 1.1.x

See [`CHANGELOG.md`](./CHANGELOG.md) for the full migration guide.

Summary:
- Pinta CLI dependency removed. `pinta login` no longer required
- `PINTA_CODEX_ENDPOINT` / `PINTA_CODEX_API_KEY` → `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` (legacy keys are still recognized for backward compatibility and auto-migrated on the next `npm run setup`)
- PreToolUse fail-close removed. Every hook exits 0 on success
- `member.identity.*` resource attributes removed

### Migration actions

| Channel | Action |
|---------|--------|
| **Pinta Manager v0.2+** | Automatic. On the next reconcile, the existing hook entry is replaced with the manager-installed 1.2.0 entry, and `PINTA_*` keys in `~/.codex/pinta-codex.env` are renamed to `OTEL_*`. |
| **Git clone (existing users)** | Run `git pull && npm run setup` once. Setup auto-migrates legacy `PINTA_CODEX_*` keys to OTel keys (with a `.bak` backup). |
| **No re-setup** | If the hooks themselves are still 1.0.x/1.1.x code, they keep working. If `dist/` has been built at 1.2.0 but only `PINTA_CODEX_*` keys remain, the backward-compat path kicks in (re-setup recommended). |

## Repo layout

```text
pinta-codex/
├── .codex-plugin/plugin.json   # plugin manifest (forward-compatible with future auto-discovery)
├── .agents/plugins/marketplace.json   # local marketplace pointer
├── .github/workflows/          # CI (PR validation + dist/ rebuild on main)
├── hooks.json                  # template using ${CODEX_PLUGIN_ROOT} — resolved by install-hooks
├── LICENSE                     # PolyForm Noncommercial 1.0.0
├── CHANGELOG.md                # version history + BREAKING CHANGES
├── docs/
│   ├── installation-guide.md   # end-user install walkthrough
│   └── codex-vs-claude-code.md # UX differences vs pinta-cc
├── src/
│   ├── core/                   # OSS-reusable (config, transport, otlp, redact, retry-queue, trace, types, identity stub)
│   ├── handlers/               # per-event handlers (gates + shared tool-gate + generic observe)
│   └── index.ts                # stdin → type guard → handler dispatch
├── tests/
│   ├── core/                   # vitest tests (otlp, hook inventory, self-version)
│   └── handlers/               # gate output-envelope tests
├── tools/
│   ├── setup.ts                # one-shot interactive installer
│   ├── doctor.ts               # read-only health check
│   ├── install-hooks.ts        # merge into ~/.codex/hooks.json
│   ├── uninstall-hooks.ts      # remove pinta-codex entries
│   ├── mock-server.ts          # local OTLP viewer
│   ├── test-otlp.ts            # span-flattening checks (legacy)
│   ├── test-redact.ts          # redaction checks (legacy)
│   └── _lib.ts                 # shared utilities (migrateLegacyEnvKeys etc.)
├── vitest.config.ts
└── .plugin-data/               # created at runtime (trace.json, failed-spans.jsonl)
```

## License

PolyForm Noncommercial 1.0.0. See [`LICENSE`](./LICENSE).
