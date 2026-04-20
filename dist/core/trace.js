"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraceManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function generateUlid() {
    const now = Date.now();
    // 10 chars timestamp (48-bit ms)
    let ts = "";
    let t = now;
    for (let i = 0; i < 10; i++) {
        ts = CROCKFORD[t & 31] + ts;
        t = Math.floor(t / 32);
    }
    // 16 chars randomness (80-bit)
    const rand = crypto_1.default.randomBytes(10);
    let r = "";
    for (let i = 0; i < 10; i++) {
        r += CROCKFORD[rand[i] & 31];
    }
    // pad to 16 chars
    while (r.length < 16)
        r += CROCKFORD[0];
    return ts + r;
}
class TraceManager {
    tracePath;
    constructor(config) {
        this.tracePath = config.tracePath;
    }
    /** Start a new trace for each user prompt hook. */
    newTrace() {
        const traceId = generateUlid();
        this.save(traceId);
        return traceId;
    }
    /** Return the current trace id, creating one when needed. */
    currentTrace() {
        try {
            const data = fs_1.default.readFileSync(this.tracePath, "utf-8");
            const { traceId } = JSON.parse(data);
            if (traceId)
                return traceId;
        }
        catch {
            // no trace file yet
        }
        return this.newTrace();
    }
    save(traceId) {
        fs_1.default.mkdirSync(path_1.default.dirname(this.tracePath), { recursive: true });
        fs_1.default.writeFileSync(this.tracePath, JSON.stringify({ traceId }));
    }
}
exports.TraceManager = TraceManager;
//# sourceMappingURL=trace.js.map