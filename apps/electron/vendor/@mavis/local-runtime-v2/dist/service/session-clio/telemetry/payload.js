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
export function buildReportEvalStepBodies(input, ...legacyArgs) {
    const normalized = normalizeReportEvalStepBodiesInput(input, legacyArgs);
    const { trajectoryId, steps, maxSteps, maxBodyBytes, sessionMetadata = {} } = normalized;
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
function normalizeReportEvalStepBodiesInput(input, legacyArgs) {
    return typeof input === 'string'
        ? {
            trajectoryId: input,
            steps: legacyArgs[0] ?? [],
            maxSteps: legacyArgs[1] ?? Number.MAX_SAFE_INTEGER,
            maxBodyBytes: legacyArgs[2] ?? Number.MAX_SAFE_INTEGER,
            sessionMetadata: legacyArgs[3],
        }
        : input;
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
            allSettledSuccessfully(promises),
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
async function allSettledSuccessfully(promises) {
    await Promise.all(promises);
    return true;
}
export function collectSensitiveValues(value, values) {
    if (!value || typeof value !== 'object')
        return;
    const seen = new WeakSet();
    const queue = [value];
    while (queue.length > 0) {
        const current = queue.pop();
        if (!isObjectValue(current) || seen.has(current))
            continue;
        seen.add(current);
        collectSensitiveObjectEntries(current, values, queue);
    }
}
function isObjectValue(value) {
    return value !== null && typeof value === 'object';
}
function collectSensitiveObjectEntries(current, values, queue) {
    for (const [key, child] of Object.entries(current)) {
        if (isSensitiveFieldKey(key) && typeof child === 'string' && child.length >= 6) {
            values.add(child);
            continue;
        }
        if (isObjectValue(child))
            queue.push(child);
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
            return trackJsonObject(ancestors, this, nested);
        });
        return serialized ?? 'null';
    }
    catch {
        return JSON.stringify({ serialization_error: true });
    }
}
function trackJsonObject(ancestors, parent, nested) {
    while (ancestors.length > 0 && ancestors.at(-1) !== parent)
        ancestors.pop();
    if (ancestors.includes(nested))
        return '[Circular]';
    // Steps keep an image's type and size, never its base64 payload.
    const tracked = evalImagePlaceholder(nested) ?? nested;
    ancestors.push(tracked);
    return tracked;
}
export function isSensitiveFieldKey(key) {
    if (!key)
        return false;
    return SENSITIVE_FIELD_KEYS.has(key.toLowerCase().replace(/[-_.]/g, ''));
}
function normalizePositiveInteger(value, fallback) {
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
/** Bounds the copy-on-write walk; deeper values are reported as they are. */
const EVAL_IMAGE_PROJECTION_MAX_DEPTH = 32;
/**
 * Eval keeps the type and size of every image block but never its base64 payload. Only the
 * objects on a path to an image are copied; everything else is shared with the input.
 */
export function withoutEvalImageData(value) {
    return projectWithoutImageData(value, 0);
}
function projectWithoutImageData(value, depth) {
    const placeholder = evalImagePlaceholder(value);
    if (placeholder)
        return placeholder;
    if (typeof value !== 'object' || value === null || depth >= EVAL_IMAGE_PROJECTION_MAX_DEPTH) {
        return value;
    }
    if (Array.isArray(value))
        return projectArrayWithoutImageData(value, depth);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return value;
    return projectObjectWithoutImageData(value, depth);
}
function projectArrayWithoutImageData(values, depth) {
    let changed = false;
    const projected = values.map((entry) => {
        const next = projectWithoutImageData(entry, depth + 1);
        changed ||= next !== entry;
        return next;
    });
    return changed ? projected : values;
}
function projectObjectWithoutImageData(value, depth) {
    let changed = false;
    const projected = {};
    for (const [key, entry] of Object.entries(value)) {
        const next = projectWithoutImageData(entry, depth + 1);
        changed ||= next !== entry;
        projected[key] = next;
    }
    return changed ? projected : value;
}
function evalImagePlaceholder(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const data = Reflect.get(value, 'data');
    if (Reflect.get(value, 'type') !== 'image' || typeof data !== 'string')
        return undefined;
    const mimeType = Reflect.get(value, 'mimeType');
    return {
        type: 'image',
        ...(typeof mimeType === 'string' ? { mimeType } : {}),
        dataOmitted: true,
        dataBytes: base64DecodedBytes(data),
    };
}
function base64DecodedBytes(data) {
    let padding = 0;
    if (data.endsWith('='))
        padding = data.endsWith('==') ? 2 : 1;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
//# sourceMappingURL=payload.js.map