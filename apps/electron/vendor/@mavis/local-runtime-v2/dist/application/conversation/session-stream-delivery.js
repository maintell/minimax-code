import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
import { isSideChatSendOrigin } from '@mavis/shared/sidechat-send-origin';
import { sanitizeDisplayAttachment, } from '../../service/session-system/index.js';
import { turnAdmissionError } from './errors.js';
import { queryCollapseSteeringProjection } from './query-collapse-identity.js';
import { projectPeerMessageOrigin } from './peer-message-origin.js';
export function mapV2TurnStreamResult(result) {
    if (!result.accepted) {
        const error = directSendAdmissionError(result.reason);
        return streamError(error);
    }
    return { ok: true, source: mapV2SessionFrames(result.frames) };
}
export function openV2SessionStream(frames) {
    return { ok: true, source: mapV2SessionFrames(frames) };
}
function mapV2SessionFrames(frames) {
    const upstream = frames[Symbol.asyncIterator]();
    const queued = [{ dataJson: '{"type":10}' }];
    let closed = false;
    let reading = false;
    let closePromise;
    const done = () => ({
        done: true,
        value: undefined,
    });
    const closeUpstream = async () => {
        await upstream.return?.();
        return done();
    };
    const close = () => {
        if (closePromise)
            return closePromise;
        if (closed)
            return Promise.resolve(done());
        closed = true;
        queued.length = 0;
        closePromise = closeUpstream();
        return closePromise;
    };
    const pull = async () => {
        while (!closed) {
            const result = await upstream.next();
            if (closed)
                return done();
            if (result.done) {
                closed = true;
                return { done: false, value: { dataJson: '[DONE]' } };
            }
            const data = mapV2Frame(result.value);
            const mapped = data.map((value, index) => withCursor(result.value, value, index === data.length - 1));
            const first = mapped.shift();
            if (!first)
                continue;
            queued.push(...mapped);
            return { done: false, value: first };
        }
        return done();
    };
    const read = async () => {
        reading = true;
        try {
            return await pull();
        }
        finally {
            reading = false;
        }
    };
    const mapped = {
        [Symbol.asyncIterator]() {
            return mapped;
        },
        next() {
            const available = queued.shift();
            if (available)
                return Promise.resolve({ done: false, value: available });
            if (closed)
                return Promise.resolve(done());
            if (reading)
                return Promise.reject(new Error('Concurrent mapped stream reads are invalid'));
            return read();
        },
        return: close,
    };
    return mapped;
}
function mapV2SessionFrame(frame) {
    if (frame.kind === 'query-collapse-view') {
        const view = toQueryCollapseSseView(frame.data);
        return view ? [{ type: 'query_collapse_view', query_collapse_view: view }] : [];
    }
    return mapStandardV2Frame(frame);
}
function mapStandardV2Frame(frame) {
    if (frame.kind === 'resync-required')
        return [{ type: 'resume_overflow' }];
    if (frame.kind === 'message-committed' || frame.kind === 'durable-message') {
        return frameMessages(frame.data).map((message) => ({
            type: 2,
            agent_message: toSseMessage(message),
        }));
    }
    if (frame.kind === 'session-status') {
        return [
            {
                type: 'session_status',
                session_status: { type: recordString(frame.data, 'status') ?? 'started' },
            },
        ];
    }
    if (frame.kind === 'turn-terminal') {
        return [
            {
                type: 'session_status',
                session_status: terminalSessionStatus(frame.data),
            },
        ];
    }
    if (frame.kind === 'runtime-event' || frame.kind === 'action-required')
        return [frame.data];
    return [{ type: frame.kind, data: frame.data }];
}
function toQueryCollapseSseView(value) {
    const queryKey = recordString(value, 'queryKey');
    const currentTurnId = recordString(value, 'currentTurnId');
    const forceExpanded = recordBoolean(value, 'forceExpanded');
    const processingStartedAtMs = recordNumber(value, 'processingStartedAtMs');
    const processingFinishedAtMs = recordNumber(value, 'processingFinishedAtMs');
    if (queryKey === undefined ||
        currentTurnId === undefined ||
        forceExpanded === undefined ||
        processingStartedAtMs === undefined) {
        return undefined;
    }
    return {
        query_key: queryKey,
        current_turn_id: currentTurnId,
        force_expanded: forceExpanded,
        processing_started_at_ms: processingStartedAtMs,
        ...(processingFinishedAtMs !== undefined
            ? { processing_finished_at_ms: processingFinishedAtMs }
            : {}),
    };
}
function mapV2Frame(frame) {
    const mapped = mapV2SessionFrame(frame).map(jsonFrame);
    return frame.kind === 'turn-terminal' &&
        frame.messageActionDeltas &&
        frame.messageActionDeltas.length > 0
        ? [{ messageActionDeltas: [...frame.messageActionDeltas] }, ...mapped]
        : mapped;
}
function jsonFrame(data) {
    return {
        dataJson: typeof data === 'string' ? data : JSON.stringify(data),
    };
}
function withCursor(frame, mapped, includeCursor) {
    return {
        ...mapped,
        ...(includeCursor && frame.cursor ? { cursor: frame.cursor } : {}),
    };
}
function frameMessages(data) {
    if (!isRecord(data))
        return [];
    const messages = Array.isArray(data.messages) ? data.messages : [data];
    return messages.filter(isRecord);
}
function toSseMessage(message) {
    const withSteering = toSseSteeringFields(toSseSideChatOrigin(toSseMessageOrigin(message)));
    if (!Array.isArray(withSteering.attachments))
        return withSteering;
    return { ...withSteering, attachments: withSteering.attachments.map(toSseAttachment) };
}
function toSseSteeringFields(message) {
    const queryKey = typeof message.query_key === 'string' ? message.query_key : undefined;
    return { ...message, ...queryCollapseSteeringProjection(queryKey) };
}
function toSseMessageOrigin(message) {
    if (message.origin !== undefined)
        return message;
    const questionnaireOrigin = projectQuestionnaireResponseOrigin(message);
    if (questionnaireOrigin)
        return questionnaireOrigin;
    const backgroundOrigin = projectBackgroundTaskOrigin(message);
    if (backgroundOrigin)
        return backgroundOrigin;
    const peerOrigin = projectPeerMessageOrigin(message);
    if (peerOrigin)
        return { ...message, origin: peerOrigin };
    if (message.source !== 'cron' || !isRecord(message.sourceContext)) {
        return message;
    }
    const cronId = firstString([message.sourceContext.cronId]);
    if (!cronId)
        return message;
    const runId = firstString([message.sourceContext.runId]);
    return {
        ...message,
        origin: { rawMeta: { cronId, ...(runId ? { runId } : {}) } },
    };
}
function projectQuestionnaireResponseOrigin(message) {
    if (message.source !== 'questionnaire' || !isRecord(message.sourceContext))
        return undefined;
    const origin = message.sourceContext.origin;
    return isOrdinaryQuestionnaireResponseOrigin(origin) ? { ...message, origin } : undefined;
}
function projectBackgroundTaskOrigin(message) {
    if (message.source !== 'background-task' || !isRecord(message.sourceContext))
        return undefined;
    const origin = message.sourceContext.origin;
    return isRecord(origin) ? { ...message, origin } : undefined;
}
/** Mirrors the history projection so a live SideChat hand-back gets its label too. */
function toSseSideChatOrigin(message) {
    if (message.origin !== undefined || !isRecord(message.sourceContext))
        return message;
    const origin = message.sourceContext.origin;
    return isSideChatSendOrigin(origin) ? { ...message, origin } : message;
}
function toSseAttachment(value) {
    const sanitized = sanitizeDisplayAttachment(value);
    if (!isRecord(sanitized))
        return sanitized;
    const meta = isRecord(sanitized.meta) ? sanitized.meta : undefined;
    const local = isRecord(sanitized.local) ? sanitized.local : undefined;
    if (!meta && !local && !isRecord(sanitized.cloud))
        return sanitized;
    return toFlatSseAttachment(sanitized, meta, local);
}
function toFlatSseAttachment(attachment, meta, local) {
    const filePath = firstString([
        attachment.file_path,
        attachment.filePath,
        local?.filePath,
        local?.file_path,
    ]);
    const fileName = firstString([attachment.file_name, attachment.fileName, meta?.fileName, meta?.file_name]) ??
        filePath?.split(/[\\/]/u).pop() ??
        'attachment';
    const mimeType = firstString([
        attachment.mime_type,
        attachment.mimeType,
        meta?.mimeType,
        meta?.mime_type,
    ]);
    const attachmentType = firstString([
        attachment.type,
        meta?.attachmentType,
        meta?.attachment_type,
    ]);
    const assetId = firstString([
        attachment.asset_id,
        attachment.assetId,
        local?.assetId,
        local?.asset_id,
    ]);
    const desktopPath = firstString([
        attachment.desktop_path,
        attachment.desktopPath,
        local?.desktopPath,
        local?.desktop_path,
    ]);
    const previewUrl = firstString([
        attachment.data_url,
        attachment.dataUrl,
        attachment.preview_url,
        attachment.previewUrl,
        local?.dataUrl,
        local?.data_url,
    ]);
    return {
        type: attachmentType === 'image' || mimeType?.startsWith('image/') ? 'image' : 'file',
        file_path: filePath ?? '',
        file_name: fileName,
        mime_type: mimeType ?? '',
        ...stringFields([
            ['asset_id', assetId],
            ['desktop_path', desktopPath],
            ['data_url', previewUrl],
        ]),
    };
}
function firstString(values) {
    return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}
function stringFields(entries) {
    return Object.fromEntries(entries.filter(hasStringValue));
}
function hasStringValue(entry) {
    return entry[1] !== undefined;
}
function terminalStatus(status) {
    if (status === 'completed')
        return 'finished';
    if (status === 'aborted')
        return 'aborted';
    return 'error';
}
function terminalSessionStatus(data) {
    const type = terminalStatus(recordString(data, 'status'));
    if (type !== 'error')
        return { type };
    const message = recordString(data, 'error');
    const errorCode = recordNumber(data, 'errorCode');
    const errorDetail = recordString(data, 'detail');
    const errorSource = recordString(data, 'errorSource');
    return {
        type,
        ...(message !== undefined ? { message } : {}),
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(errorDetail !== undefined ? { errorDetail } : {}),
        ...(errorSource !== undefined ? { errorSource } : {}),
    };
}
function recordString(value, key) {
    return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}
function recordNumber(value, key) {
    return isRecord(value) && typeof value[key] === 'number' ? value[key] : undefined;
}
function recordBoolean(value, key) {
    return isRecord(value) && typeof value[key] === 'boolean' ? value[key] : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function streamError(error) {
    return {
        ok: false,
        status: error.status,
        body: {
            sseErrorCode: error.sseErrorCode ?? 0,
            code: error.status,
            key: error.key ?? 'LOCAL_RUNTIME_STREAM_OPEN_FAILED',
            message: error.message,
            ...(error.detail ? { detail: error.detail } : {}),
        },
    };
}
/** Direct reason-to-error mappings that need no extra policy resolution. */
const DIRECT_SEND_ADMISSION_ERRORS = {
    'invalid-session': {
        status: 404,
        key: 'local_session_not_found',
        message: 'Session not found',
    },
    'priority-blocked': {
        status: 409,
        key: 'local_session_has_queued_messages',
        message: 'An earlier queued message has priority',
    },
    'queue-paused': {
        status: 409,
        key: 'local_session_queue_paused',
        message: 'The session Queue is paused',
    },
    'ingress-conflict': {
        status: 409,
        key: 'local_turn_ingress_conflict',
        message: 'Turn ingress conflicts',
    },
    duplicate: {
        status: 409,
        key: 'local_turn_duplicate',
        message: 'Turn was already accepted',
    },
    'session-deleting': {
        status: 409,
        key: 'local_session_deleting',
        message: 'Session is being deleted',
    },
    'computer-use-requires-new-turn': {
        status: 409,
        key: 'local_computer_use_requires_new_turn',
        message: 'Computer Use requires a new Turn. Keep the message queued until the current Turn ends.',
    },
    'compaction-active': {
        status: 409,
        key: 'local_session_compacting',
        message: 'Session compaction is active',
    },
};
function directSendAdmissionError(reason) {
    const admissionError = turnAdmissionError(reason);
    if (admissionError)
        return admissionError;
    if (isTurnContinuationAdmissionReason(reason)) {
        return turnContinuationAdmissionError(reason);
    }
    const policyError = runtimeAdmissionError(reason) ?? planAdmissionError(reason);
    if (policyError)
        return policyError;
    return (DIRECT_SEND_ADMISSION_ERRORS[reason] ?? {
        status: 409,
        key: 'local_session_busy',
        message: 'Session already has an active Turn. Use queue send to deliver the message after it.',
    });
}
function isTurnContinuationAdmissionReason(reason) {
    return reason === 'unavailable' || reason === 'waiting-for-user';
}
function turnContinuationAdmissionError(reason) {
    if (reason === 'unavailable') {
        return {
            status: 409,
            key: 'local_turn_continuation_unavailable',
            message: 'The current Turn is already complete or cannot be continued',
        };
    }
    return {
        status: 409,
        key: 'local_turn_waiting_for_user',
        message: 'The current Turn is waiting for user input',
    };
}
function runtimeAdmissionError(reason) {
    if (reason === 'policy:runtime:draining') {
        return {
            status: 503,
            key: 'local_runtime_draining',
            message: 'MCode is preparing to restart. Retry after reconnecting.',
        };
    }
    if (reason === 'policy:runtime:auth-pending') {
        return {
            status: 503,
            key: 'local_runtime_auth_pending',
            message: 'MCode is waiting for Desktop authentication. Reconnect the development machine from Desktop.',
        };
    }
    return undefined;
}
function planAdmissionError(reason) {
    if (reason === 'policy:plan:lifecycle-active') {
        return {
            status: 409,
            key: 'local_plan_lifecycle_active',
            message: 'Plan review processing must finish before this request can run',
        };
    }
    if (reason === 'policy:plan:questionnaire-active') {
        return {
            status: 409,
            key: 'local_plan_questionnaire_active',
            message: 'Resolve the pending questionnaire before entering Plan Mode',
        };
    }
    if (reason === 'policy:plan:entry-disabled') {
        return {
            status: 409,
            key: 'local_plan_entry_disabled',
            message: 'New Plan Mode entry is temporarily disabled',
        };
    }
    if (reason === 'policy:plan:mode-conflict') {
        return {
            status: 409,
            key: 'local_plan_mode_conflict',
            message: 'Session mode changed before Plan Mode entry',
        };
    }
    return undefined;
}
//# sourceMappingURL=session-stream-delivery.js.map