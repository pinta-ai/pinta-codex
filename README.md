# Pinta Codex

Codex security monitoring plugin. Converts Codex hook events into OTLP spans and ships them to a Pinta trace endpoint. Mirrors [`pinta-cc`](https://github.com/awarecorp/pinta-cc) — same OTLP schema, same fail-close policy, same retry queue — reshaped for Codex's current plugin surface.

> **For end users:** see [`docs/installation-guide.md`](./docs/installation-guide.md).
> **For how this differs from `pinta-cc`:** see [`docs/codex-vs-claude-code.md`](./docs/codex-vs-claude-code.md).
> This README is the developer-oriented overview.

## Quick start

```bash
git clone https://github.com/awarecorp/pinta-codex.git
cd pinta-codex
npm install
npm run setup      # interactive: build + env + config.toml + hooks.json + identity check
codex              # hooks fire immediately
npm run doctor     # verify everything green
```

`setup` is idempotent and non-destructive — re-run any time. `doctor` is read-only.

## What it captures

Codex's hook system (experimental; enable via `features.codex_hooks = true` in `~/.codex/config.toml`) fires five event types today, all handled:

| Event | Notes |
|-------|-------|
| `SessionStart` | health ping + drain retry queue |
| `UserPromptSubmit` | starts a new ULID trace per user turn |
| `PreToolUse` | **Bash tool only** (current Codex limitation). Fail-close on missing identity. |
| `PostToolUse` | **Bash tool only** (current Codex limitation) |
| `Stop` | final flush |

Each invocation spawns `node dist/index.js`, resolves Pinta identity, maps the event into one OTLP span, and posts to `{endpoint}/traces`.

## Behavior

- OTLP/HTTP JSON transport with `x-api-key` header
- Top-level event fields flattened into `codex.*` span attributes (Bronze schema; sibling adaptors `pinta-cc` and `mcp-logger` emit `cc.*` and `mcp.*` respectively)
- **Fail-close** on missing identity for `PreToolUse` (`exit 2` + `permissionDecision: "deny"`)
- **Fail-open** for every other hook failure (exit 1, guidance to stderr)
- File-backed retry queue at `.plugin-data/failed-spans.jsonl` (cap 1000), drained opportunistically on the next hook
- One trace per user turn, keyed by `UserPromptSubmit`-generated ULID

## Configuration

`npm run setup` writes endpoint and API key to `~/.codex/pinta-codex.env`. Environment variables override the file:

```bash
export PINTA_CODEX_ENDPOINT="https://security.company.com"
export PINTA_CODEX_API_KEY="your-api-key"
```

Resolution order (later wins): `~/.codex/pinta-codex.env` → `PINTA_CODEX_*` env vars. `CLAUDE_PLUGIN_OPTION_ENDPOINT` / `CLAUDE_PLUGIN_OPTION_API_KEY` are accepted as aliases for parity with `pinta-cc`.

Optional overrides:

```bash
export CODEX_PLUGIN_DATA="/abs/path/to/.plugin-data"     # override runtime data dir
export CODEX_CLI_VERSION="$(codex --version | awk '{print $NF}')"
export CODEX_HOME="/abs/path/to/.codex"                  # override ~/.codex during install
```

## Pinta identity

The plugin shells out to the `pinta` CLI for user/email resolution. Install the Pinta CLI first, then:

```bash
pinta login
pinta identity id
pinta identity email
```

If identity cannot be resolved, `PreToolUse` blocks the tool call (`exit 2`); other hooks exit non-zero after writing guidance to stderr.

## Manual install (advanced)

If you'd rather not run the interactive setup:

```bash
npm run build
npm run install-hooks                  # merges absolute paths into ~/.codex/hooks.json
npm run install-hooks -- --dry-run     # preview without writing
```

`install-hooks` is idempotent: it prints `already up to date` when `~/.codex/hooks.json` already matches the bundled template, and auto-detects + removes stale `pinta-codex` entries from prior installs at a different path (reporting `removed N stale pinta-codex entries`).

Then manually add to `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

> **Why an install script?** Codex does not yet auto-load hooks from `.codex-plugin/plugin.json`, and `~/.codex/hooks.json` performs no `${CODEX_PLUGIN_ROOT}` substitution. The install script rewrites the bundled `hooks.json` template with absolute paths and merges it into the user-level file. When Codex adds plugin-hook auto-discovery, the bundled manifest + template will work natively and this step goes away.

## Uninstall

```bash
npm run uninstall-hooks
```

Removes only entries whose command references this plugin's `dist/index.js`. `~/.codex/pinta-codex.env` and the `config.toml` feature flag are left alone — delete manually if you want a full tear-down.

## Local development

Mock server (OTLP viewer at `http://localhost:3000`):

```bash
npm run mock-server
```

In another shell, point setup at the mock endpoint and start Codex:

```bash
printf 'http://localhost:3000\ntest-token\n' | npm run setup
codex
```

Unit checks:

```bash
npm run test:otlp
npm run test:redact
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run setup` | one-shot interactive installer (build + env + config + hooks + identity) |
| `npm run doctor` | read-only health check; exits 1 on failure |
| `npm run build` | `tsc` into `dist/` |
| `npm run dev` | `tsc --watch` |
| `npm run install-hooks` | merge entries into `~/.codex/hooks.json` (supports `-- --dry-run`) |
| `npm run uninstall-hooks` | remove this plugin's entries from `~/.codex/hooks.json` |
| `npm run mock-server` | local OTLP collector for testing |
| `npm run test:otlp` | span-flattening unit checks |
| `npm run test:redact` | redaction unit checks |

## Repo layout

```text
pinta-codex/
├── .codex-plugin/plugin.json   # plugin manifest (forward-compatible with future auto-discovery)
├── .agents/plugins/marketplace.json   # local marketplace pointer
├── .github/workflows/          # CI (PR validation + dist/ rebuild on main)
├── hooks.json                  # template using ${CODEX_PLUGIN_ROOT} — resolved by install-hooks
├── LICENSE                     # PolyForm Noncommercial 1.0.0
├── docs/
│   ├── installation-guide.md   # end-user install walkthrough
│   └── codex-vs-claude-code.md # UX differences vs pinta-cc
├── src/
│   ├── core/                   # OSS-reusable (config, transport, otlp, redact, retry-queue, trace, types, identity)
│   ├── enterprise/             # Pinta-specific identity resolver (DI seam)
│   ├── handlers/               # per-event handlers
│   └── index.ts                # stdin → type guard → handler dispatch
├── tools/
│   ├── setup.ts                # one-shot interactive installer
│   ├── doctor.ts               # read-only health check
│   ├── install-hooks.ts        # merge into ~/.codex/hooks.json
│   ├── uninstall-hooks.ts      # remove pinta-codex entries
│   ├── mock-server.ts          # local OTLP viewer
│   ├── test-otlp.ts            # span-flattening checks
│   └── test-redact.ts          # redaction unit tests
└── .plugin-data/               # created at runtime (trace.json, failed-spans.jsonl)
```

## License

PolyForm Noncommercial 1.0.0. See [`LICENSE`](./LICENSE).
