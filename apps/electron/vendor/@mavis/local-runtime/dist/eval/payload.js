import { createHash } from 'node:crypto';
const LOCAL_TRAJECTORY_PREFIX = 'local-pi-';
const MAX_TRAJECTORY_ID_BYTES = 128;
export const LOCAL_PI_CAPTURE_ORIGIN = 101;
const REDACTED = '[REDACTED]';
const SENSITIVE_FIELD_KEYS = new Set([
    'accesstoken',
    'accesskeysecret',
    'apikey',
    'authorization',
    'cookie',
    'credential',
    'idtoken',
    'password',
    'privatekey',
    'refreshtoken',
    'requestsk',
    'secret',
    'sk',
    'token',
]);
export function buildLocalEvalMetaInfoStep(metaInfo, sensitiveValues) {
    return {
        stepType: 'session_lifecycle',
        role: 'system',
        content: 'meta_info',
        usageJson: safeJsonStringify({ schema: 'mavis.eval_step.v1', kind: 'meta_info', meta_info: metaInfo }, sensitiveValues),
    };
}
export function buildReportEvalStepBodies(trajectoryId, steps, maxSteps, maxBodyBytes, sessionMetadata = {}) {
    const envelope = JSON.stringify({
        trajectory_id: trajectoryId,
        capture_origin: LOCAL_PI_CAPTURE_ORIGIN,
        agent_name: sessionMetadata.agentName,
        session_kind: sessionMetadata.sessionKind,
        session_type: sessionMetadata.sessionType,
        parent_trajectory_id: sessionMetadata.parentTrajectoryId,
        session_origin: sessionMetadata.sessionOrigin,
        session_created_at_ms: sessionMetadata.sessionCreatedAtMs,
        is_default_workspace: sessionMetadata.isDefaultWorkspace,
        session_purpose: sessionMetadata.sessionPurpose,
    });
    const prefix = `${envelope.slice(0, -1)},"steps":[`;
    const suffix = ']}';
    const envelopeBytes = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8');
    const bodies = [];
    const droppedStepIndexes = [];
    let serializedSteps = [];
    let batchBytes = envelopeBytes;
    let containsMetaInfo = false;
    const flush = () => {
        if (serializedSteps.length === 0)
            return;
        bodies.push({ body: `${prefix}${serializedSteps.join(',')}${suffix}`, containsMetaInfo });
        serializedSteps = [];
        batchBytes = envelopeBytes;
        containsMetaInfo = false;
    };
    for (const step of steps) {
        const serializedStep = JSON.stringify(projectEvalStep(step));
        const stepBytes = Buffer.byteLength(serializedStep, 'utf8');
        const separatorBytes = serializedSteps.length === 0 ? 0 : 1;
        if (serializedSteps.length > 0 &&
            (serializedSteps.length >= maxSteps || batchBytes + separatorBytes + stepBytes > maxBodyBytes)) {
            flush();
        }
        if (envelopeBytes + stepBytes > maxBodyBytes) {
            droppedStepIndexes.push(step.stepIndex);
            continue;
        }
        batchBytes += (serializedSteps.length === 0 ? 0 : 1) + stepBytes;
        serializedSteps.push(serializedStep);
        containsMetaInfo ||= step.stepType === 'session_lifecycle' && step.content === 'meta_info';
    }
    flush();
    return { bodies, droppedStepIndexes };
}
function projectEvalStep(step) {
    return {
        seq: step.clientProducedTs * 1_000 + step.stepIndex,
        step_type: toCanonicalEvalStepType(step.stepType),
        role: step.role,
        content: step.content,
        tool_call_id: step.toolCallId,
        tool_name: step.toolName,
        args_json: step.argsJson,
        result_json: step.resultJson,
        is_error: step.isError,
        duration_ms: step.durationMs,
        usage_json: step.usageJson ?? step.rawJson,
        client_produced_ts: step.clientProducedTs,
    };
}
/**
 * Serializes one Session Clio `ReportEvalSteps` body.
 *
 * Each `payloadJson` is spliced in verbatim rather than parsed and re-encoded,
 * so the bytes a retry sends are the bytes the producer committed. Key order,
 * number formatting and escaping therefore cannot drift between attempts, which
 * is what lets the server treat a replay as idempotent instead of a conflicting
 * rewrite of an immutable record.
 */
export function buildClioStepsBody(input) {
    const steps = input.steps.map((step) => `{"seq":${step.seq},"step_type":${step.stepType},"client_produced_ts":${step.clientProducedTs},"clio_payload":${step.payloadJson}}`);
    return `{"trajectory_id":${JSON.stringify(input.trajectoryId)},"capture_origin":${input.captureOrigin},"steps":[${steps.join(',')}]}`;
}
export function buildLocalTrajectoryId(sessionId) {
    const normalized = sessionId.replace(/[^A-Za-z0-9._-]/gu, '_');
    if (normalized.length > 0 &&
        normalized === sessionId &&
        Buffer.byteLength(sessionId, 'utf8') <= MAX_TRAJECTORY_ID_BYTES &&
        sessionId.replaceAll('.', '').length > 0) {
        return sessionId;
    }
    const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    const maxStemBytes = MAX_TRAJECTORY_ID_BYTES -
        Buffer.byteLength(LOCAL_TRAJECTORY_PREFIX, 'utf8') -
        Buffer.byteLength(digest, 'utf8') -
        1;
    const stem = Buffer.from(normalized, 'utf8').subarray(0, maxStemBytes).toString('utf8');
    return `${LOCAL_TRAJECTORY_PREFIX}${stem}-${digest}`;
}
function toCanonicalEvalStepType(stepType) {
    switch (stepType) {
        case 'message':
            return 1;
        case 'tool_call':
            return 2;
        case 'tool_result':
            return 3;
        case 'session_lifecycle':
        case 'runtime_event':
            return 4;
        case 'usage':
            return 5;
        default:
            throw new Error(`unsupported eval step type: ${stepType}`);
    }
}
export async function settleWithin(promises, timeoutMs) {
    let timeout;
    try {
        return await Promise.race([
            Promise.all(promises).then(() => true),
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timeout !== undefined)
            clearTimeout(timeout);
    }
}
export function collectSensitiveValues(value, values) {
    if (!value || typeof value !== 'object')
        return;
    const seen = new WeakSet();
    const queue = [value];
    while (queue.length > 0) {
        const current = queue.pop();
        if (!current || typeof current !== 'object' || seen.has(current))
            continue;
        seen.add(current);
        for (const [key, child] of Object.entries(current)) {
            if (isSensitiveFieldKey(key) && typeof child === 'string' && child.length >= 6) {
                values.add(child);
            }
            else if (child && typeof child === 'object') {
                queue.push(child);
            }
        }
    }
}
export function maskText(value, sensitiveValues) {
    let masked = value;
    for (const secret of sensitiveValues)
        masked = masked.split(secret).join(REDACTED);
    return masked;
}
export function safeJsonStringify(value, sensitiveValues) {
    const ancestors = [];
    try {
        const serialized = JSON.stringify(value, function replacer(key, nested) {
            if (isSensitiveFieldKey(key))
                return REDACTED;
            if (typeof nested === 'bigint')
                return nested.toString();
            if (typeof nested === 'string')
                return maskText(nested, sensitiveValues);
            if (!nested || typeof nested !== 'object')
                return nested;
            while (ancestors.length > 0 && ancestors.at(-1) !== this)
                ancestors.pop();
            if (ancestors.includes(nested))
                return '[Circular]';
            ancestors.push(nested);
            return nested;
        });
        return serialized ?? 'null';
    }
    catch {
        return JSON.stringify({ serialization_error: true });
    }
}
export function isSensitiveFieldKey(key) {
    if (!key)
        return false;
    return SENSITIVE_FIELD_KEYS.has(key.toLowerCase().replace(/[-_.]/g, ''));
}
export function normalizePositiveInteger(value, fallback) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        return value;
    return fallback;
}
export function truncateUtf8(text, maxBytes) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= maxBytes)
        return text;
    const marker = `\n[truncated ${bytes - maxBytes} bytes]`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const keepBytes = Math.max(0, maxBytes - markerBytes);
    const prefix = Buffer.from(text, 'utf8')
        .subarray(0, keepBytes)
        .toString('utf8')
        .replace(/\uFFFD+$/u, '');
    return `${prefix}${marker}`;
}
export function extractMessageText(message) {
    if (!('content' in message))
        return '';
    const content = message.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map((part) => {
        if (!part || typeof part !== 'object')
            return '';
        if (!('text' in part))
            return '';
        return typeof part.text === 'string' ? part.text : '';
    })
        .filter(Boolean)
        .join('\n');
}
export function describeModel(model) {
    if (!model || typeof model !== 'object')
        return undefined;
    if (!('id' in model))
        return undefined;
    const id = model.id;
    const provider = 'provider' in model ? model.provider : undefined;
    if (typeof id !== 'string' || id.trim().length === 0)
        return undefined;
    if (typeof provider !== 'string' || provider.trim().length === 0)
        return id.trim();
    return `${provider.trim()}/${id.trim()}`;
}
/** Normalize capture budgets once, retaining the wire field/body hard caps. */
export function localEvalCaptureLimits(input) {
    const stepLimit = 1 << 20;
    const snapshotLimit = 16 << 20;
    return {
        stepBytes: Math.min(normalizePositiveInteger(input.maxStepFieldBytes, stepLimit), stepLimit),
        snapshotBytes: Math.min(normalizePositiveInteger(input.maxSnapshotBytes, snapshotLimit), snapshotLimit),
    };
}
//# sourceMappingURL=payload.js.map