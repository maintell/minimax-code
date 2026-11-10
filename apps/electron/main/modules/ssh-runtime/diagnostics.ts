import { randomUUID } from "node:crypto";
let sink = null;
const MAX_TEXT_BYTES = 16 * 1024;
const NOOP = { record() { }, fail() { } };
const SENSITIVE_KEY = /api[-_]?key|token|secret|authorization|password|credential|signature|sig/iu;
export function setSshDiagnosticSink(value) {
    sink = value;
}
export function shouldEnableSshDiagnostics(buildEnv) {
    return buildEnv === 'dev' || buildEnv === 'test';
}
export function sanitizeSshDiagnosticText(value) {
    // Redact before truncating so a truncated credential cannot escape its matcher.
    const safe = value
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, '[redacted private key]')
        .split('\n')
        .map((line) => /\b(?:bearer|basic)\s|(?:authorization|cookie|_auth|api[-_]?key|token|password|secret|credential|signature)[\w-]*[^\w\r\n]*[:=]|[?&]sig=|:\/\/[^/\s]+@|\bnpm_[A-Za-z0-9]+|\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/iu.test(line)
        ? '[redacted credential-bearing line]'
        : line)
        .join('\n');
    const bytes = Buffer.from(safe, 'utf8');
    return bytes.length > MAX_TEXT_BYTES
        ? `[truncated ${bytes.length - MAX_TEXT_BYTES} bytes]\n${bytes.subarray(-MAX_TEXT_BYTES).toString('utf8')}`
        : safe;
}
/** Only explicit lifecycle fields and bounded command output enter this diagnostic channel. */
export function startSshDiagnostic(operation, context = {}, parentId, attemptId) {
    const target = sink;
    if (!target)
        return NOOP;
    const id = randomUUID();
    const correlatedAttemptId = attemptId ?? parentId ?? id;
    const startedAtMs = performance.now();
    const record = (event, fields = {}) => {
        try {
            const safe = Object.fromEntries(Object.entries({ ...context, ...fields }).map(([key, value]) => [
                key,
                key !== 'signal' && SENSITIVE_KEY.test(key)
                    ? '****'
                    : typeof value === 'string'
                        ? sanitizeSshDiagnosticText(value)
                        : value,
            ]));
            target.info(`[SshDiagnostic] ${JSON.stringify({
                ...safe,
                timestampMs: Date.now(),
                operationId: id,
                parentId,
                attemptId: correlatedAttemptId,
                operation,
                event,
                elapsedMs: Math.max(0, performance.now() - startedAtMs),
            })}`);
        }
        catch {
            // A diagnostic sink must never alter installation or transport behavior.
        }
    };
    const diagnostic = {
        id,
        attemptId: correlatedAttemptId,
        record,
        fail(error, fields = {}) {
            const details = error && typeof error === 'object'
                ? error
                : {};
            record('failed', {
                message: error instanceof Error ? error.message : String(error),
                code: typeof details.code === 'string' ? details.code : undefined,
                stdout: typeof details.stdout === 'string' ? details.stdout : undefined,
                stderr: typeof details.stderr === 'string' ? details.stderr : undefined,
                exitCode: typeof details.exitCode === 'number' || details.exitCode === null
                    ? details.exitCode
                    : undefined,
                signal: typeof details.signal === 'string' || details.signal === null
                    ? details.signal
                    : undefined,
                commandStarted: typeof details.commandStarted === 'boolean' ? details.commandStarted : undefined,
                stdoutBytes: typeof details.stdoutBytes === 'number' ? details.stdoutBytes : undefined,
                stderrBytes: typeof details.stderrBytes === 'number' ? details.stderrBytes : undefined,
                ...fields,
            });
        },
    };
    record('start');
    return diagnostic;
}
