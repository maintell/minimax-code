import { logger } from '../common/logger.js';
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
        const agentName = readBoundedString(context.sessionId, fields, 'agentName', 'agent_name', MAX_AGENT_NAME_CHARS);
        if (agentName !== undefined) {
            metadata.agentName = agentName === 'main' || agentName === 'mavis' ? 'mavis' : agentName;
        }
        const sessionKind = readBoundedString(context.sessionId, fields, 'sessionKind', 'session_kind', MAX_SESSION_KIND_CHARS);
        if (sessionKind !== undefined)
            metadata.sessionKind = sessionKind;
        const sessionType = readBoundedString(context.sessionId, fields, 'sessionType', 'session_type', MAX_SESSION_TYPE_CHARS);
        if (sessionType !== undefined)
            metadata.sessionType = sessionType;
        const parentSessionId = readSessionField(context.sessionId, fields, 'parentSessionId', 'parent_trajectory_id');
        if (parentSessionId === null || parentSessionId === '') {
            metadata.parentTrajectoryId = '';
        }
        else if (parentSessionId !== undefined) {
            if (typeof parentSessionId !== 'string') {
                logInvalidSessionField(context.sessionId, 'parent_trajectory_id', 'not_string');
            }
            else {
                try {
                    metadata.parentTrajectoryId = buildLocalTrajectoryId(parentSessionId);
                }
                catch (error) {
                    logSessionFieldFailure(context.sessionId, 'parent_trajectory_id', error);
                }
            }
        }
        const sessionOrigin = readBoundedString(context.sessionId, fields, 'sessionOrigin', 'session_origin', MAX_SESSION_ORIGIN_CHARS);
        if (sessionOrigin !== undefined)
            metadata.sessionOrigin = sessionOrigin;
        const createdAtMs = readSessionField(context.sessionId, fields, 'sessionCreatedAtMs', 'session_created_at_ms');
        if (createdAtMs !== undefined) {
            if (typeof createdAtMs === 'number' &&
                Number.isSafeInteger(createdAtMs) &&
                createdAtMs >= 0) {
                metadata.sessionCreatedAtMs = createdAtMs;
            }
            else {
                logInvalidSessionField(context.sessionId, 'session_created_at_ms', 'not_safe_nonnegative_integer');
            }
        }
        const isDefaultWorkspace = readSessionField(context.sessionId, fields, 'isDefaultWorkspace', 'is_default_workspace');
        if (isDefaultWorkspace !== undefined) {
            if (typeof isDefaultWorkspace === 'boolean') {
                metadata.isDefaultWorkspace = isDefaultWorkspace;
            }
            else {
                logInvalidSessionField(context.sessionId, 'is_default_workspace', 'not_boolean');
            }
        }
        const purpose = readUtf8String(context.sessionId, fields, 'sessionPurpose', 'session_purpose', MAX_SESSION_PURPOSE_BYTES);
        if (purpose !== undefined)
            metadata.sessionPurpose = purpose;
        return Object.keys(metadata).length === 0 ? EMPTY_SESSION_METADATA : metadata;
    }
    catch (error) {
        logSessionFieldFailure(context.sessionId, 'session_fields', error);
        return EMPTY_SESSION_METADATA;
    }
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
function readBoundedString(sessionId, fields, source, field, maxChars) {
    const value = readSessionField(sessionId, fields, source, field);
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || Array.from(value).length > maxChars) {
        logInvalidSessionField(sessionId, field, 'not_bounded_string');
        return undefined;
    }
    return value;
}
function readUtf8String(sessionId, fields, source, field, maxBytes) {
    const value = readSessionField(sessionId, fields, source, field);
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
        logInvalidSessionField(sessionId, field, 'not_text_within_utf8_limit');
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