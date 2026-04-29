"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transport = void 0;
const otlp_js_1 = require("./otlp.js");
const retry_queue_js_1 = require("./retry-queue.js");
const TIMEOUT_MS = 5000;
function hintFor(status) {
    if (status === 401 || status === 403)
        return " — check OTEL_EXPORTER_OTLP_HEADERS";
    if (status === 404)
        return " — check OTEL_EXPORTER_OTLP_ENDPOINT path";
    if (status >= 500)
        return " — collector may be down";
    return "";
}
class Transport {
    config;
    queue;
    constructor(config) {
        this.config = config;
        this.queue = new retry_queue_js_1.RetryQueue(config.pluginData);
    }
    async send(payload) {
        if (!this.config.endpoint)
            return; // Silent disable
        const ok = await this.post(payload);
        if (!ok)
            this.queue.enqueue(payload);
    }
    async flush() {
        if (!this.config.endpoint)
            return;
        if (!this.queue.tryAcquireLock())
            return;
        try {
            const entries = this.queue.readAll();
            if (entries.length === 0)
                return;
            const merged = (0, otlp_js_1.mergeBatch)(entries.map((e) => e.payload));
            const ok = await this.post(merged);
            if (ok)
                this.queue.rewrite([]);
        }
        finally {
            this.queue.release();
        }
    }
    async post(payload) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(`${this.config.endpoint}/traces`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...this.config.headers,
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            });
            if (!res.ok) {
                process.stderr.write(`[pinta-codex] OTLP ${res.status}${hintFor(res.status)}\n`);
                return false;
            }
            return true;
        }
        catch (err) {
            process.stderr.write(`[pinta-codex] OTLP failed: ${err.message ?? String(err)}\n`);
            return false;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.Transport = Transport;
//# sourceMappingURL=transport.js.map