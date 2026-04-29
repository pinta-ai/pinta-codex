# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 정체성

이 repo는 Codex hook 이벤트를 OTLP/HTTP span으로 변환해 임의의 OpenTelemetry 컬렉터에 전송하는 **Generic OTLP forwarder 플러그인**이다.

- Pinta CLI 의존 없음. Identity 해석은 릴레이 계층(Pinta Manager 또는 사용자 파이프라인)에서 처리.
- `src/enterprise/` 디렉토리 제거됨 (v1.2.0). `PintaIdentityResolver` 삭제.
- Codex는 아직 plugin manifest 자동 로드 미지원 — `install-hooks` 로 `~/.codex/hooks.json` 에 절대경로 직접 기입.

## 핵심 데이터 흐름

```
Codex hook
  → stdin (JSON)
  → src/index.ts (stdin parse → handler routing)
  → handler → buildOtlpPayload({ event, traceId, now? })
  → Transport.send()
    → POST ${OTEL_EXPORTER_OTLP_ENDPOINT}/traces
    → 실패 시: .plugin-data/failed-spans.jsonl 에 enqueue
              다음 hook 호출 시 flush
```

Identity 체크 없음. Guard 없음. fail-close 없음. 모든 hook은 성공 시 exit 0.

## 모듈 경계

| 디렉토리 | 역할 | 제약 |
|----------|------|------|
| `src/core/` | OSS-재사용 가능 (config, otlp builder, transport, retry-queue, trace, types, identity stub) | enterprise 코드 import 금지 |
| `src/handlers/` | hook 카테고리별 핸들러 | core만 import |
| `src/index.ts` | stdin 파싱 + 핸들러 라우팅 | 진입점 |
| `src/enterprise/` | **v1.2.0에서 삭제됨** | — |
| `src/core/identity.ts` | 빈 stub (릴레이가 identity 부착) | 코드 추가 전 설계 검토 필요 |

## 실행 모델

Codex는 hook 이벤트마다 `node dist/index.js`를 새로 spawn한다.

- 프로세스 간 in-memory 상태 공유 불가
- 프로세스 간 상태는 전부 파일(`.plugin-data/`)
- OTLP BatchSpanProcessor 같은 장기 배치 로직 불가
- 외부 데몬·sidecar 금지

## 트레이스 ID 계약

- `UserPromptSubmit` 핸들러만 `newTrace()` 호출 → 새 ULID 저장 (`.plugin-data/trace.json`)
- 이후 모든 hook은 `currentTrace()`로 동일 ID 재사용
- **한 사용자 턴 = 하나의 traceId. 이 계약을 깨지 말 것.**

## OTLP 전송

- `POST ${OTEL_EXPORTER_OTLP_ENDPOINT}/traces` — OTLP/HTTP JSON 본문
- 헤더: `OTEL_EXPORTER_OTLP_HEADERS` 파싱 (`key1=val1,key2=val2` 형식)
- endpoint 미설정 시 silent disable (throw 없음)
- timeout 5s. 실패 → `.plugin-data/failed-spans.jsonl` enqueue (cap 1000)
- 단일 hook = `resourceSpans` 1개 = span 1개. 큐 flush 시 여러 span을 하나의 body로 배치
- `service.name = "codex"`, `telemetry.sdk.name = "pinta-codex"`

## Env file 패턴 + legacy migration

pinta-codex 는 Claude Code 의 userConfig 환경이 아니라 자체 env 파일을 사용한다. env-bridge 없음.

`src/core/config.ts` 가 설정을 해석하는 순서:
1. `process.env` 의 `OTEL_EXPORTER_OTLP_*` (최우선)
2. `~/.codex/pinta-codex.env` (setup 이 관리)
3. Legacy `PINTA_CODEX_ENDPOINT` / `PINTA_CODEX_API_KEY` (backward-compat)
4. Parity `CLAUDE_PLUGIN_OPTION_ENDPOINT` / `CLAUDE_PLUGIN_OPTION_API_KEY`

`tools/_lib.ts:migrateLegacyEnvKeys(p)` — 다음 `npm run setup` 실행 시 `PINTA_CODEX_*` 키를 OTel-spec 이름으로 자동 rename. 원본을 `.bak` 으로 백업 후 덮어씀.

**불변 규칙:** 명시적 `OTEL_EXPORTER_OTLP_*` env var 가 있으면 파일 값이나 legacy 키로 덮어쓰지 않는다.

## 새 hook 이벤트 추가

1. `hooks/hooks.json` — 엔트리 추가
2. `src/core/types.ts` — interface + type guard 추가
3. `src/handlers/<new>.ts` — 핸들러 작성 (canonical shape 유지: Transport flush → currentTrace/newTrace → buildOtlpPayload → send → exit 0)
4. `src/index.ts` — 분기 추가

현재 5개 이벤트: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Codex 는 현재 PreToolUse/PostToolUse 를 Bash 툴에 한해서만 발화한다.

## 새 attribute 추가

별도 코드 불필요. `flattenEvent()`가 hook event의 모든 top-level 필드를 자동으로 `codex.<key>` 속성으로 평탄화한다. hook event 타입에 필드만 추가하면 됨.

## 테스트

```bash
npm test   # vitest
```

테스트 위치: `tests/core/*.test.ts` (OTLP builder, identity absence regression guard 등 커버).

새 동작은 같은 파일 내 기존 테스트에 추가. 독립적 새 기능이면 같은 디렉토리에 새 파일.

로컬 통합 테스트:
1. `npm run mock-server` — `http://localhost:3000`에서 span 확인
2. `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000 codex`

Legacy assert-based 검사: `npm run test:otlp`, `npm run test:redact` (계속 동작하지만 vitest 로 마이그레이션 권장).

## 배포 정책

- npm publish는 M9d로 연기됨
- marketplace 업데이트: `.codex-plugin/plugin.json` + `package.json`의 version 동시 증가
- `dist/`는 GitHub Actions가 빌드·커밋 (로컬 커밋 불필요)

## Cross-project 맥락

상위 `pinta-ai/CLAUDE.md`의 결합 정책을 따른다. OTLP wire format (`codex.*` attribute 키, `ingest.type: codex`)은 `aware-backend`의 `/traces` 파서와 **Tight** 계약이다. span attribute 키 변경 시 backend parser 영향을 먼저 확인할 것.
