import { UserMessageCommitAdmissionError, UserMessageCommitConflictError, } from './repo/contract.js';
import { createUserMessageId } from '../shared/user-message-id.js';
/** Retries transient Message writes once without repeating deterministic rejections. */
export async function retryUserMessageCommit(operation) {
    try {
        return await operation();
    }
    catch (error) {
        if (error instanceof UserMessageCommitAdmissionError ||
            error instanceof UserMessageCommitConflictError) {
            throw error;
        }
        return operation();
    }
}
/** Lightweight idempotent projection directly onto the authoritative Message table. */
export class UserMessageCommitService {
    options;
    nowMs;
    makeMessageId;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.makeMessageId = options.makeMessageId ?? ((input) => createUserMessageId(input));
    }
    async commit(input) {
        const messageId = input.userMessageId ?? this.makeMessageId(input);
        const result = await this.options.messages.commitUserMessage({
            sessionId: input.sessionId,
            turnId: input.turnId,
            unconsumedFromTurnIds: input.unconsumedFromTurnIds,
            unstartedFromTurnIds: input.unstartedFromTurnIds,
            ...(input.source ? { source: input.source } : {}),
            ...(input.sourceContext ? { sourceContext: { ...input.sourceContext } } : {}),
            message: {
                msg_id: messageId,
                role: 'user',
                msg_content: input.content ?? '',
                ...optionalEditContent(input.editContent),
                msg_type: 1,
                timestamp: input.timestamp ?? this.nowMs(),
                kind: input.kind,
                ...(input.sourceMessageId ? { source_message_id: input.sourceMessageId } : {}),
                ...(input.queryKey ? { query_key: input.queryKey } : {}),
                ...(input.attachments?.length
                    ? { attachments: input.attachments.map(toDisplayAttachment) }
                    : {}),
            },
        });
        if (!isCommittedUserMessage(result.message, messageId)) {
            throw new TypeError(`Stable committed user Message row is malformed: ${messageId}`);
        }
        return {
            sessionId: input.sessionId,
            turnId: input.turnId,
            messageKey: input.messageKey,
            created: result.created,
            firstUserMessageForSession: result.firstUserMessageForSession,
            message: result.message,
        };
    }
}
function optionalEditContent(editContent) {
    return editContent === undefined ? {} : { editContent };
}
function toDisplayAttachment(attachment) {
    if (attachment.meta || attachment.local || attachment.cloud) {
        return toStructuredDisplayAttachment(attachment);
    }
    return toLegacyDisplayAttachment(attachment);
}
function toStructuredDisplayAttachment(attachment) {
    return {
        ...(attachment.meta ? { meta: { ...attachment.meta } } : {}),
        ...(attachment.local ? { local: { ...attachment.local } } : {}),
        ...(attachment.cloud ? { cloud: { ...attachment.cloud } } : {}),
    };
}
function toLegacyDisplayAttachment(attachment) {
    return {
        ...(attachment.type ? { type: attachment.type } : {}),
        ...(attachment.filePath ? { file_path: attachment.filePath } : {}),
        ...(attachment.fileName ? { file_name: attachment.fileName } : {}),
        ...(attachment.mimeType ? { mime_type: attachment.mimeType } : {}),
        ...(attachment.dataUrl ? { data_url: attachment.dataUrl } : {}),
        ...(attachment.assetId ? { asset_id: attachment.assetId } : {}),
    };
}
function isCommittedUserMessage(message, messageId) {
    return (message.msg_id === messageId &&
        message.role === 'user' &&
        typeof message.msg_content === 'string' &&
        typeof message.timestamp === 'number' &&
        Number.isFinite(message.timestamp));
}
//# sourceMappingURL=user-message-commit-service.js.map