import { isInputSafetyDecision } from '../../../content-safety/index.js';
import { QueueDataCorruptionError } from './contract.js';
import { isUserMessageId } from '../../shared/user-message-id.js';
export function encodeQueueItem(item) {
    return JSON.stringify(item);
}
export function decodeQueueRow(row) {
    const item = parseQueueItem(row.dataJson);
    if (!item ||
        item.sessionId !== row.sessionId ||
        item.itemId !== row.itemId ||
        item.status !== row.status ||
        item.createdAt !== row.createdAtMs) {
        throw new QueueDataCorruptionError(row.sessionId, row.itemId);
    }
    return item;
}
function parseQueueItem(raw) {
    try {
        const value = JSON.parse(raw);
        return isQueueItem(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
export function isQueueItem(value) {
    if (!hasBase(value))
        return false;
    if (value.status === 'queued')
        return claimFieldsAbsent(value);
    return (value.status === 'claimed' &&
        nonEmpty(value.claimId) &&
        finite(value.claimedAt) &&
        optionalString(value.claimOwnerId) &&
        optionalFinite(value.claimLeaseExpiresAt));
}
export function isQueueMessageSource(value) {
    return SOURCES.has(value);
}
export function isQueueMessageInput(value) {
    if (!hasQueueMessageShape(value))
        return false;
    return (hasValidAttachmentsAndSafety(value) &&
        optionalArray(value.displayAttachments, record) &&
        validMessageOptionals(value) &&
        optionalRecord(value.quotedMessage, isQuoted) &&
        optionalRecord(value.channelContext, isChannelContext));
}
function hasQueueMessageShape(value) {
    return record(value) && typeof value.content === 'string' && Array.isArray(value.attachments);
}
function hasValidAttachmentsAndSafety(value) {
    return (value.attachments.every(isAttachment) &&
        (value.inputSafetyDecision === undefined || isInputSafetyDecision(value.inputSafetyDecision)));
}
function hasBase(value) {
    if (!record(value))
        return false;
    return hasIdentity(value) && hasOptionalMetadata(value);
}
function hasIdentity(value) {
    return (nonEmpty(value.itemId) &&
        nonEmpty(value.sessionId) &&
        nonEmpty(value.agentName) &&
        isQueueMessageSource(value.source) &&
        (value.status === 'queued' || value.status === 'claimed') &&
        isQueueMessageInput(value.message) &&
        finite(value.createdAt));
}
function hasOptionalMetadata(value) {
    return ([value.requestedTurnId, value.clientRequestId, value.dedupeKey].every(optionalString) &&
        (value.userMessageId === undefined || isUserMessageId(value.userMessageId)) &&
        optionalFinite(value.expiresAt) &&
        optionalRecord(value.channelContext, isChannelContext) &&
        optionalRecord(value.model, isModel) &&
        optionalRecord(value.immediateSendBatch, isQueueImmediateSendBatch) &&
        validDeliveryAttempts(value.deliveryAttempts));
}
export function isQueueImmediateSendBatch(value) {
    if (!record(value) ||
        !nonEmpty(value.id) ||
        !Array.isArray(value.members) ||
        value.members.length === 0)
        return false;
    const ids = new Set();
    return value.members.every((member) => {
        if (!record(member) || !isUserMessageId(member.userMessageId) || ids.has(member.userMessageId))
            return false;
        ids.add(member.userMessageId);
        return validImmediateSendMember(member);
    });
}
function validImmediateSendMember(member) {
    return (isQueueMessageInput(member.message) &&
        nonEmpty(member.messageKey) &&
        optionalRecord(member.queueClaim, (claim) => record(claim) && nonEmpty(claim.itemId) && nonEmpty(claim.claimId)) &&
        finite(member.createdAt) &&
        validUnconsumedTurnIds(member.unconsumedFromTurnIds) &&
        validUnconsumedTurnIds(member.unstartedFromTurnIds) &&
        optionalString(member.sourceMessageId) &&
        optionalRecord(member.model, isModel) &&
        validBatchProvenance(member.provenance));
}
function validBatchProvenance(value) {
    return (record(value) &&
        isQueueMessageSource(value.source) &&
        nonEmpty(value.routingFingerprint) &&
        optionalRecord(value.sourceContext, record));
}
function claimFieldsAbsent(value) {
    return (value.claimId === undefined &&
        value.claimedAt === undefined &&
        value.claimOwnerId === undefined &&
        value.claimLeaseExpiresAt === undefined);
}
function isAttachment(value) {
    return (record(value) &&
        (value.type === 'file' || value.type === 'image') &&
        typeof value.filePath === 'string' &&
        typeof value.fileName === 'string' &&
        typeof value.mimeType === 'string' &&
        [value.dataUrl, value.assetId, value.error].every(optionalString));
}
function isQuoted(value) {
    return record(value) && typeof value.text === 'string' && optionalString(value.senderName);
}
function validMessageOptionals(value) {
    return (optionalBoolean(value.hideUserMessage) &&
        [value.displayContent, value.queueItemId, value.source, value.clientIntent].every(optionalString));
}
function isChannelContext(value) {
    return (record(value) &&
        ['platform', 'chatType', 'chatId', 'senderId', 'clientName'].every((key) => typeof value[key] === 'string') &&
        optionalString(value.targetAgentId));
}
function isModel(value) {
    return record(value) && validModelIdentity(value) && validModelParameters(value);
}
function validModelIdentity(value) {
    return (optionalString(value.provider_id) &&
        optionalString(value.model_id) &&
        optionalString(value.variant));
}
function validModelParameters(value) {
    return (validModelReasoning(value.reasoning) &&
        isModelContext(value.context_limit) &&
        isModelContext(value.max_output_tokens) &&
        isFrozenModel(value.frozen) &&
        isQueueModelSource(value.modelSource) &&
        isParameterSnapshot(value.parameterSnapshot) &&
        optionalRecord(value.thinking, isModelThinking));
}
function validModelReasoning(value) {
    return value === undefined || typeof value === 'boolean';
}
function isFrozenModel(value) {
    return value === undefined || value === true;
}
function isQueueModelSource(value) {
    return value === undefined || value === 'agent' || value === 'runtime-default';
}
function isModelContext(value) {
    return (value === undefined ||
        (Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647));
}
function isParameterSnapshot(value) {
    return (value === undefined ||
        (record(value) &&
            ['default', 'selection', 'legacy'].includes(String(value.context)) &&
            ['default', 'selection', 'legacy'].includes(String(value.effort))));
}
function isModelThinking(value) {
    return record(value) && optionalString(value.effort);
}
const SOURCES = new Set([
    'api',
    'cron',
    'task',
    'background-task',
    'team',
    'thread-goal',
    'questionnaire',
    'communication',
    'code_review',
    'greeting',
    'channel:wechat',
    'channel:feishu',
    'channel:telegram',
]);
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0;
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function optionalString(value) {
    return value === undefined || typeof value === 'string';
}
function optionalBoolean(value) {
    return value === undefined || typeof value === 'boolean';
}
function optionalFinite(value) {
    return value === undefined || finite(value);
}
function optionalArray(value, validate) {
    return value === undefined || (Array.isArray(value) && value.every(validate));
}
function optionalRecord(value, validate) {
    return value === undefined || validate(value);
}
function validUnconsumedTurnIds(value) {
    return (value === undefined ||
        (Array.isArray(value) &&
            value.length > 0 &&
            value.every(nonEmpty) &&
            new Set(value).size === value.length));
}
function validDeliveryAttempts(value) {
    if (value === undefined)
        return true;
    if (!Array.isArray(value) || value.length === 0)
        return false;
    const claims = new Set();
    const turns = new Set();
    return value.every((attempt) => {
        if (!record(attempt) || !nonEmpty(attempt.claimId) || !nonEmpty(attempt.turnId))
            return false;
        if (claims.has(attempt.claimId) || turns.has(attempt.turnId))
            return false;
        claims.add(attempt.claimId);
        turns.add(attempt.turnId);
        return true;
    });
}
//# sourceMappingURL=codec.js.map