# pinta-codex

Generic OTLP forwarder for Codex hook events.

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

All five events that Codex's hook system (experimental; requires `features.codex_hooks = true` in `~/.codex/config.toml`) currently emits are handled.

| Event | Notes |
|-------|-------|
| `SessionStart` | health ping + drain retry queue |
| `UserPromptSubmit` | starts a new ULID trace per user turn |
| `PreToolUse` | **Bash tool only** (current Codex limitation) |
| `PostToolUse` | **Bash tool only** (current Codex limitation) |
| `Stop` | final flush |

Each invocation spawns `node dist/index.js`, maps the event to a single OTLP span, and POSTs it to `{endpoint}/traces`.

## Behavior

- OTLP/HTTP JSON transport. Headers are read from `OTEL_EXPORTER_OTLP_HEADERS` (`key=val,key=val` format)
- Top-level event fields are flattened into `codex.*` span attributes (Bronze; sibling adaptors use `cc.*`, `mcp.*`)
- **No fail-close** — every hook exits 0 on success (transmission failures are absorbed by the retry queue)
- Disk-backed retry queue at `.plugin-data/failed-spans.jsonl` (cap 1000). Drained on the next hook invocation
- One trace per user turn — based on the `UserPromptSubmit` ULID

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
codex_hooks = true
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
# Manually remove the [features] codex_hooks = true line from ~/.codex/config.toml
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
│   ├── handlers/               # per-event handlers
│   └── index.ts                # stdin → type guard → handler dispatch
├── tests/
│   └── core/                   # vitest tests (otlp.test.ts etc.)
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
