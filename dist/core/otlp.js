"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeBatch = void 0;
exports.buildOtlpPayload = buildOtlpPayload;
const os_1 = __importDefault(require("os"));
const core_1 = require("@pinta-ai/core");
Object.defineProperty(exports, "mergeBatch", { enumerable: true, get: function () { return core_1.mergeBatch; } });
const PLUGIN_VERSION = "1.3.1"; // keep in sync with .codex-plugin/plugin.json
/**
 * Resolve the Codex CLI version from an explicit env if present.
 * Hooks run as short-lived processes, so we keep this intentionally simple.
 */
let cachedCliVersion = null;
function getCodexVersion() {
    if (cachedCliVersion !== null)
        return cachedCliVersion;
    cachedCliVersion = process.env.CODEX_CLI_VERSION || "unknown";
    return cachedCliVersion;
}
/**
 * Attribute keys for which redaction (Tier 1) is skipped. Truncation (Tier 3)
 * still applies. These are identifiers, enums, or our own resource attrs that
 * are known-safe and where false-positive masking would hurt more than help.
 */
const SKIP_REDACT_KEYS = new Set([
    "codex.hook",
    "codex.tool_name",
    "codex.tool_use_id",
    "codex.session_id",
    "codex.transcript_path",
    "codex.cwd",
    "codex.permission_mode",
]);
// flattenEvent emits codex.tool_input as a single JSON-stringified attribute (no
// nested flattening today), so strict equality matches actual behavior. If
// nested flattening is ever added, re-evaluate to avoid extending bash context
// to unrelated nested keys (e.g. codex.tool_input.file_path).
const BASH_CONTEXT_KEYS = new Set([
    "codex.tool_input",
    "codex.tool_response",
]);
const ATTR_POLICY = {
    skipRedactKeys: SKIP_REDACT_KEYS,
    bashContextKeys: BASH_CONTEXT_KEYS,
};
function flattenEvent(event) {
    const out = [];
    // Discriminator first so the Pinta backend's detectIngestType hits it cheaply.
    out.push({ key: "ingest.type", value: { stringValue: "codex" } });
    // Always set codex.hook explicitly so server queries have a canonical key
    // regardless of incoming field name.
    out.push({ key: "codex.hook", value: { stringValue: event.hook_event_name } });
    const rest = {};
    for (const [k, v] of Object.entries(event)) {
        if (k === "hook_event_name")
            continue; // covered by codex.hook above
        rest[k] = v;
    }
    out.push(...(0, core_1.attrsFromRecord)(rest, "codex", ATTR_POLICY));
    return out;
}
function resourceAttrs() {
    return [
        { key: "service.name", value: { stringValue: "codex" } },
        { key: "service.version", value: { stringValue: getCodexVersion() } },
        { key: "telemetry.sdk.name", value: { stringValue: "pinta-codex" } },
        { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
        { key: "telemetry.sdk.version", value: { stringValue: PLUGIN_VERSION } },
        { key: "process.pid", value: { intValue: process.pid } },
        { key: "process.owner", value: { stringValue: os_1.default.userInfo().username } },
        { key: "host.name", value: { stringValue: os_1.default.hostname() } },
        { key: "host.arch", value: { stringValue: os_1.default.arch() } },
    ];
}
function buildOtlpPayload(args) {
    return (0, core_1.buildPayload)({
        traceId: args.traceId,
        spanName: `codex.${(0, core_1.snakeCase)(args.event.hook_event_name)}`,
        attributes: flattenEvent(args.event),
        resource: resourceAttrs(),
        scope: { name: "pinta-codex", version: PLUGIN_VERSION },
        now: args.now,
        // codex's GuardResult intentionally omits the `userMessage` field that core
        // models. guardAttrs never reads it, so widening here is behavior-safe.
        guard: args.guard,
    });
}
//# sourceMappingURL=otlp.js.map