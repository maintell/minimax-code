import { logger } from '../../../infra/logging/logger.js';
import { buildLocalTrajectoryId } from './payload.js';
const MAX_AGENT_NAME_CHARS = 64;
const MAX_SESSION_KIND_CHARS = 32;
const MAX_SESSION_TYPE_CHARS = 16;
const MAX_SESSION_ORIGIN_CHARS = 32;
const MAX_SESSION_PURPOSE_BYTES = 65_535;
const EMPTY_SESSION_METADATA = {};
export function collectLocalEvalSessionMetadata(context) {
    try {
        const fields = context.sessionFields;
        if (!fields)
            return EMPTY_SESSION_METADATA;
        const metadata = {};
        addBoundedSessionFields(context, fields, metadata);
        addParentTrajectory(context.sessionId, fields, metadata);
        addSessionOrigin(context, fields, metadata);
        addSessionCreatedAt(context, fields, metadata);
        addDefaultWorkspace(context, fields, metadata);
        addSessionPurpose(context, fields, metadata);
        return Object.keys(metadata).length === 0 ? EMPTY_SESSION_METADATA : metadata;
    }
    catch (error) {
        logSessionFieldFailure(context.sessionId, 'session_fields', error);
        return EMPTY_SESSION_METADATA;
    }
}
function addBoundedSessionFields(context, fields, metadata) {
    const agentName = readBoundedString({ context, fields, source: 'agentName', field: 'agent_name', maxChars: MAX_AGENT_NAME_CHARS });
    if (agentName !== undefined)
        metadata.agentName = agentName === 'main' || agentName === 'mavis' ? 'mavis' : agentName;
    const sessionKind = readBoundedString({ context, fields, source: 'sessionKind', field: 'session_kind', maxChars: MAX_SESSION_KIND_CHARS });
    if (sessionKind !== undefined)
        metadata.sessionKind = sessionKind;
    const sessionType = readBoundedString({ context, fields, source: 'sessionType', field: 'session_type', maxChars: MAX_SESSION_TYPE_CHARS });
    if (sessionType !== undefined)
        metadata.sessionType = sessionType;
}
function addParentTrajectory(sessionId, fields, metadata) {
    const value = readSessionField(sessionId, fields, 'parentSessionId', 'parent_trajectory_id');
    if (value === null || value === '') {
        metadata.parentTrajectoryId = '';
    }
    else if (typeof value === 'string') {
        try {
            metadata.parentTrajectoryId = buildLocalTrajectoryId(value);
        }
        catch (error) {
            logSessionFieldFailure(sessionId, 'parent_trajectory_id', error);
        }
    }
    else if (value !== undefined) {
        logInvalidSessionField(sessionId, 'parent_trajectory_id', 'not_string');
    }
}
function addSessionOrigin(context, fields, metadata) {
    const value = readBoundedString({ context, fields, source: 'sessionOrigin', field: 'session_origin', maxChars: MAX_SESSION_ORIGIN_CHARS });
    if (value !== undefined)
        metadata.sessionOrigin = value;
}
function addSessionCreatedAt(context, fields, metadata) {
    const value = readSessionField(context.sessionId, fields, 'sessionCreatedAtMs', 'session_created_at_ms');
    if (value === undefined)
        return;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        metadata.sessionCreatedAtMs = value;
        return;
    }
    logInvalidSessionField(context.sessionId, 'session_created_at_ms', 'not_safe_nonnegative_integer');
}
function addDefaultWorkspace(context, fields, metadata) {
    const value = readSessionField(context.sessionId, fields, 'isDefaultWorkspace', 'is_default_workspace');
    if (value === undefined)
        return;
    if (typeof value === 'boolean') {
        metadata.isDefaultWorkspace = value;
        return;
    }
    logInvalidSessionField(context.sessionId, 'is_default_workspace', 'not_boolean');
}
function addSessionPurpose(context, fields, metadata) {
    const value = readUtf8String({ context, fields, source: 'sessionPurpose', field: 'session_purpose', maxBytes: MAX_SESSION_PURPOSE_BYTES });
    if (value !== undefined)
        metadata.sessionPurpose = value;
}
function readSessionField(sessionId, fields, source, field) {
    try {
        return fields[source];
    }
    catch (error) {
        logSessionFieldFailure(sessionId, field, error);
        return undefined;
    }
}
function readBoundedString(input) {
    const { context, fields, source, field, maxChars } = input;
    const value = readSessionField(context.sessionId, fields, source, field);
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || Array.from(value).length > maxChars) {
        logInvalidSessionField(context.sessionId, field, 'not_bounded_string');
        return undefined;
    }
    return value;
}
function readUtf8String(input) {
    const { context, fields, source, field, maxBytes } = input;
    const value = readSessionField(context.sessionId, fields, source, field);
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
        logInvalidSessionField(context.sessionId, field, 'not_text_within_utf8_limit');
        return undefined;
    }
    return value;
}
function logInvalidSessionField(sessionId, field, reason) {
    try {
        logger.warn({ sessionId, field, reason }, '[eval-capture] omitted invalid local eval session field');
    }
    catch { }
}
function logSessionFieldFailure(sessionId, field, error) {
    try {
        logger.warn({
            sessionId,
            field,
            error: error instanceof Error ? error.message : String(error),
        }, '[eval-capture] failed to collect local eval session field');
    }
    catch { }
}
//# sourceMappingURL=session-metadata.js.map