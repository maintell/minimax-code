/**
 * Latency instrumentation for the two lanes that carry SSH Runtime work.
 *
 * The lanes fail slowly for different reasons, so every record names the lane
 * it came from:
 *   - `ssh-exec`: one short-lived `ssh` process per call, so each record
 *     includes a full TCP + SSH handshake and authentication.
 *   - `app-server`: the long-lived `mcode app-server --stdio` JSON-RPC channel,
 *     where cost is round trips and serialized payload bytes instead.
 *
 * Records are emitted as single-line `key=value` pairs so they stay greppable
 * and can be aggregated without a parser.
 *
 * Instrumentation stays inert until a sink is installed, which keeps this
 * module free of Electron imports and usable from unit tests.
 */

let sink = null;
/** Install the process-wide perf sink, or pass `null` to disable recording. */
export function setSshPerfSink(next) {
    sink = next;
}
export function isSshPerfEnabled() {
    return sink !== null;
}
/**
 * Decide whether the caller should install a sink at all. Perf logging is on by
 * default in dev and opt-in elsewhere, so packaged builds stay quiet unless a
 * user is actively diagnosing a slow remote workspace.
 */
export function shouldEnableSshPerf(isDev, env = process.env) {
    const flag = env.MCODE_SSH_PERF;
    if (flag === '1' || flag === 'true')
        return true;
    if (flag === '0' || flag === 'false')
        return false;
    return isDev;
}
/** Keep one record on one line so whitespace cannot split fields apart. */
function formatValue(value) {
    return value.length === 0 ? '-' : value.replace(/\s+/gu, '_');
}
function formatFields(fields) {
    const parts = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined)
            continue;
        parts.push(`${key}=${typeof value === 'string' ? formatValue(value) : String(value)}`);
    }
    return parts.join(' ');
}
export function recordSshPerf(op, fields = {}) {
    const target = sink;
    if (!target)
        return;
    const formatted = formatFields(fields);
    target.info(formatted ? `[SshPerf] op=${op} ${formatted}` : `[SshPerf] op=${op}`);
}
const NOOP_SPAN = {
    elapsedMs: () => 0,
    mark: () => undefined,
    end: () => undefined,
};
export function startSshPerfSpan(op, fields = {}) {
    if (!sink)
        return NOOP_SPAN;
    const startedAt = Date.now();
    let lastMarkAt = startedAt;
    return {
        elapsedMs: () => Date.now() - startedAt,
        mark(stage, markFields = {}) {
            const now = Date.now();
            recordSshPerf(op, {
                ...fields,
                stage,
                sinceStartMs: now - startedAt,
                sinceLastMs: now - lastMarkAt,
                ...markFields,
            });
            lastMarkAt = now;
        },
        end(endFields = {}) {
            recordSshPerf(op, { ...fields, totalMs: Date.now() - startedAt, ...endFields });
        },
    };
}
/** Byte length of one RuntimeTransport payload, without copying large buffers. */
export function payloadByteLength(payload) {
    if (payload === undefined)
        return 0;
    if (typeof payload === 'string') {
        // Wire payloads are base64 for binary bodies, so the string length is the
        // transferred size rather than the decoded size.
        return payload.length;
    }
    return payload.byteLength;
}
/**
 * Stable short key for a remote path, so records can be correlated without
 * writing the remote directory structure into a log file.
 *
 * FNV-1a is chosen over a cryptographic digest because the renderer half of
 * this instrumentation has no synchronous hashing primitive, and both halves
 * must produce the same key for the same path. Keep this in sync with
 * `sshPerfPathKey` in `packages/ui/src/services/sshPerf.ts`.
 */
export function sshPerfPathKey(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
