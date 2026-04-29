# pinta-codex

Generic OTLP forwarder for Codex hook events.

> **엔드유저 설치 가이드:** [`docs/installation-guide.md`](./docs/installation-guide.md)
> **pinta-cc와의 차이:** [`docs/codex-vs-claude-code.md`](./docs/codex-vs-claude-code.md)
> 이 README는 개발자 관점 개요입니다.

## Channels

두 채널이 병행 운영됩니다. `~/.codex/hooks.json` 의 absolute-path prefix 로 구분되어 같은 머신에서 공존 가능합니다.

| Channel | 사용자 | 설치 |
|---------|-------|------|
| **Pinta Manager** (v0.2+) | Pinta 사용자 | catalog 가 npm tarball install → manager root prefix 로 hooks.json entry 자동 등록. **manual setup 불필요.** |
| **Git clone + npm run setup** | OSS / standalone | 아래 Quick start 참조. `~/.codex/pinta-codex.env` 에 직접 endpoint/token 작성. |

## Quick start (OSS / standalone)

```bash
git clone https://github.com/awarecorp/pinta-codex.git
cd pinta-codex
npm install
npm run setup      # interactive: build + env (OTLP collector URL) + config.toml + hooks.json
codex              # hooks fire immediately
npm run doctor     # verify everything green
```

`setup`은 idempotent — 재실행해도 안전합니다. `doctor`는 read-only.

## What it captures

Codex의 hook 시스템 (실험적; `~/.codex/config.toml`의 `features.codex_hooks = true` 활성화 필요) 이 현재 발화하는 5개 이벤트가 모두 핸들링됩니다.

| Event | Notes |
|-------|-------|
| `SessionStart` | health ping + drain retry queue |
| `UserPromptSubmit` | starts a new ULID trace per user turn |
| `PreToolUse` | **Bash tool only** (current Codex limitation) |
| `PostToolUse` | **Bash tool only** (current Codex limitation) |
| `Stop` | final flush |

각 invocation은 `node dist/index.js`를 spawn하고, 이벤트를 OTLP span 하나로 매핑한 뒤 `{endpoint}/traces`로 POST합니다.

## Behavior

- OTLP/HTTP JSON transport. 헤더는 `OTEL_EXPORTER_OTLP_HEADERS` 에서 읽음 (`key=val,key=val` 형식)
- Top-level 이벤트 필드는 `codex.*` span attribute 로 평탄화 (Bronze; 형제 adaptor는 `cc.*`, `mcp.*`)
- **No fail-close** — 모든 hook은 성공 시 exit 0 (전송 실패는 retry queue 로 흡수)
- Disk-backed retry queue at `.plugin-data/failed-spans.jsonl` (cap 1000). 다음 hook 호출 시 일괄 drain
- One trace per user turn — `UserPromptSubmit` ULID 기반

## Configuration

`npm run setup` 이 `~/.codex/pinta-codex.env` 에 endpoint + 헤더를 씁니다. 환경변수로 파일 값을 덮어쓸 수 있습니다.

```bash
# OTel-spec (primary)
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-collector.example.com"
export OTEL_EXPORTER_OTLP_HEADERS="x-pinta-relay-token=YOUR-TOKEN"

# Non-Pinta collectors
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR-TOKEN"
```

`~/.codex/pinta-codex.env` 예시:

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

v1.2부터 Pinta CLI 의존이 제거되었습니다. Identity 부착은 relay 계층 책임입니다. Pinta Manager 가 forward 시 첨부하며, OSS 사용자는 자기 pipeline 에서 처리합니다. 플러그인 자체는 identity 없이 동작하며, 어떤 hook 도 identity 부재로 차단되지 않습니다.

## Manual install (advanced)

interactive setup 을 쓰지 않으려면:

```bash
npm run build
npm run install-hooks                  # merges absolute paths into ~/.codex/hooks.json
npm run install-hooks -- --dry-run     # preview without writing
```

`install-hooks` 는 idempotent: `~/.codex/hooks.json` 이 번들 템플릿과 이미 일치하면 `already up to date` 로 no-op. 이전 경로의 stale pinta-codex 엔트리는 자동 감지·제거 (`removed N stale pinta-codex entries`).

`~/.codex/config.toml` 에 수동으로 추가:

```toml
[features]
codex_hooks = true
```

> **Why an install script?** Codex는 아직 `.codex-plugin/plugin.json` 에서 hook 을 자동 로드하지 않습니다. `install-hooks` 가 번들 `hooks.json` 템플릿의 `${CODEX_PLUGIN_ROOT}` 를 절대경로로 교체하고 user-level 파일에 merge 합니다. Codex 가 plugin-hook auto-discovery 를 추가하면 이 단계는 사라집니다.

## Uninstall

```bash
npm run uninstall-hooks
```

`dist/index.js` 를 참조하는 이 플러그인의 `~/.codex/hooks.json` 엔트리만 제거합니다. 다른 hook 은 건드리지 않습니다.

완전 제거:

```bash
rm ~/.codex/pinta-codex.env
# ~/.codex/config.toml 에서 [features] codex_hooks = true 라인 수동 삭제
```

## Local development

Mock server (OTLP viewer at `http://localhost:3000`):

```bash
npm run mock-server
```

다른 터미널에서 endpoint 를 mock 으로 설정하고 Codex 시작:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000 codex
```

또는 stdin pipe 로 setup:

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

상세한 마이그레이션 안내는 [`CHANGELOG.md`](./CHANGELOG.md) 를 참조하세요.

요약:
- Pinta CLI 의존 제거. `pinta login` 불필요
- `PINTA_CODEX_ENDPOINT` / `PINTA_CODEX_API_KEY` → `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` (legacy 키는 backward-compat 으로 인식되며 다음 `npm run setup` 시 자동 마이그레이션)
- PreToolUse fail-close 제거. 모든 hook 은 exit 0 on success
- `member.identity.*` resource attribute 제거

### 마이그레이션 액션

| 채널 | 액션 |
|------|------|
| **Pinta Manager v0.2+** | 자동. 다음 reconcile 에 기존 hook entry 가 manager-installed 1.2.0 entry 로 교체되고 `~/.codex/pinta-codex.env` 의 PINTA_* 키는 OTEL_* 로 갱신. |
| **Git clone (기존 사용자)** | `git pull && npm run setup` 1회 재실행. setup 이 legacy `PINTA_CODEX_*` 키를 OTel 키로 자동 마이그레이션 (.bak 백업). |
| **재setup 안 함** | hook 자체는 1.0.x/1.1.x 코드 그대로라면 동작 유지. 단 dist/ 가 1.2.0 으로 빌드된 상태에서 PINTA_CODEX_* 만 남아있으면 backward-compat path 로 동작 (재setup 권장). |

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
