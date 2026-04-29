import type { PintaCodexConfig } from "./config.js";
import type { OtlpPayload } from "./otlp.js";
import { mergeBatch } from "./otlp.js";
import { RetryQueue } from "./retry-queue.js";

const TIMEOUT_MS = 5000;

function hintFor(status: number): string {
  if (status === 401 || status === 403) return " — check OTEL_EXPORTER_OTLP_HEADERS";
  if (status === 404) return " — check OTEL_EXPORTER_OTLP_ENDPOINT path";
  if (status >= 500) return " — collector may be down";
  return "";
}

export class Transport {
  private queue: RetryQueue;

  constructor(private config: PintaCodexConfig) {
    this.queue = new RetryQueue(config.pluginData);
  }

  async send(payload: OtlpPayload): Promise<void> {
    if (!this.config.endpoint) return;  // Silent disable
    const ok = await this.post(payload);
    if (!ok) this.queue.enqueue(payload);
  }

  async flush(): Promise<void> {
    if (!this.config.endpoint) return;
    if (!this.queue.tryAcquireLock()) return;
    try {
      const entries = this.queue.readAll();
      if (entries.length === 0) return;
      const merged = mergeBatch(entries.map((e) => e.payload));
      const ok = await this.post(merged);
      if (ok) this.queue.rewrite([]);
    } finally {
      this.queue.release();
    }
  }

  private async post(payload: OtlpPayload): Promise<boolean> {
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
    } catch (err) {
      process.stderr.write(`[pinta-codex] OTLP failed: ${(err as Error).message ?? String(err)}\n`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
