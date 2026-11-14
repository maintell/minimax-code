import { CanonicalHistoryRepairError, isUserMessageId } from '../../../session-system/index.js';
import { prepareSteeringTeardownCanonicalInput } from '../../agent-host/assembly/local-turn-input-preparation.js';
import { prepareLocalInlineMedia, } from '../../agent-host/preparation/inline-media.js';
import { forgetToolSearchAnnouncements } from '../../agent-host/tools/tool-search.js';
import { resolveGenuineUserQueryText, resolveMessageAuthorship, } from '../../execution/message-query-authorship.js';
/** Display rows of user input that never reached the conversation (spec 4.3). */
const UNDELIVERED_KINDS = new Set(['input_rejected', 'undelivered_user']);
/**
 * A recalled message is rendered, never routed; the strict input capture
 * still wants a fingerprint, and without one keeps only the words.
 */
const RECALL_ROUTING_FINGERPRINT = 'bunny-history-repair';
/**
 * Spec 6.2: the canonical history provider backs the corrupt file up and
 * keeps its longest valid prefix, or rolls back to the newest snapshot; the
 * user messages not yet replied to after the cut come back from the
 * conversation the user sees.
 */
export function createHistoryRepair(sessions, getImageEncoding) {
    return {
        repair: async (sessionId, { turnId }) => {
            try {
                const repair = await sessions.canonicalHistory.repairCorrupted(sessionId, {
                    recall: (kept) => recallUnreplied(sessions.repositories.messages, {
                        sessionId,
                        turnId,
                        keptIds: kept.messageIds,
                        encoding: getImageEncoding?.(),
                    }),
                });
                if (!repair)
                    return { status: 'intact' };
                // The cut user messages may have carried Tool Search announcements; the
                // recalled ones are rebuilt from the visible text and carry none.
                forgetToolSearchAnnouncements(sessionId);
                const { backupFile, kind, removedCount, keptCount, recalledCount, reason } = repair;
                return {
                    status: 'repaired',
                    repair: {
                        backupFile,
                        kind,
                        removedCount,
                        keptCount,
                        recalledCount,
                        reason,
                        ...(repair.snapshot ? { snapshotGeneration: repair.snapshot.generation } : {}),
                    },
                };
            }
            catch (error) {
                if (error instanceof CanonicalHistoryRepairError)
                    return { status: 'failed' };
                throw error;
            }
        },
    };
}
/**
 * The user's own messages after the coordinator's last visible words that the
 * repaired history does not hold: typed messages and questionnaire answers
 * of earlier Turns, converted as a steering teardown converts them. This
 * Turn's input is not among them; the Turn adds it itself.
 */
async function recallUnreplied(messages, input) {
    const anchor = [...input.keptIds].reverse().find((id) => isUserMessageId(id));
    let replay = await messages.listAfter(input.sessionId, anchor);
    if (replay.status === 'missing-anchor')
        replay = await messages.listAfter(input.sessionId);
    const rows = replay.messages;
    const kept = new Set(input.keptIds);
    const lastReply = rows.map(isVisibleReply).lastIndexOf(true);
    const recalled = [];
    for (const row of rows.slice(lastReply + 1)) {
        const user = usersOwnMessage(row, input.turnId, kept);
        if (!user)
            continue;
        const message = await recalledMessage(row, user.provenance, input.encoding);
        recalled.push({ messageId: user.messageId, turnId: user.turnId, message });
    }
    return recalled;
}
/** A message the user wrote in an earlier Turn that the repaired history does not hold. */
function usersOwnMessage(row, currentTurnId, kept) {
    const messageId = row.msg_id;
    const turnId = row.turnId ?? row.meta?.turnId;
    if (!messageId || !turnId || turnId === currentTurnId)
        return undefined;
    if (!recallable(row, messageId, kept))
        return undefined;
    const provenance = {
        source: row.source ?? '',
        ...(row.sourceContext ? { sourceContext: row.sourceContext } : {}),
        routingFingerprint: RECALL_ROUTING_FINGERPRINT,
    };
    const origin = row.sourceContext?.origin;
    if (resolveMessageAuthorship({ source: provenance.source, origin }) === 'system')
        return undefined;
    return { messageId, turnId, provenance };
}
/**
 * A display row with the coordinator's visible words (spec 4.3), as the rebuild counts
 * a reply: not a row of tool calls only, a failed Turn's error row, or a
 * compaction fact.
 */
function isVisibleReply(row) {
    return (row.role === 'assistant' &&
        row.kind === undefined &&
        row.finish_reason !== 'error' &&
        (stringField(row, 'msg_content')?.trim() ?? '') !== '');
}
/** A delivered user message that the repaired history does not hold. */
function recallable(row, messageId, kept) {
    return (row.role === 'user' &&
        isUserMessageId(messageId) &&
        !kept.has(messageId) &&
        !UNDELIVERED_KINDS.has(row.kind ?? ''));
}
async function recalledMessage(row, provenance, encoding) {
    const text = stringField(row, 'editContent') ?? stringField(row, 'msg_content') ?? '';
    const attachments = await Promise.all((Array.isArray(row.attachments) ? row.attachments : []).flatMap((value) => {
        const attachment = inputAttachment(value);
        return attachment ? [inlineRecalledImage(attachment, encoding)] : [];
    }));
    const message = { text, ...(attachments.length > 0 ? { attachments } : {}) };
    const canonical = prepareSteeringTeardownCanonicalInput({ message, provenance });
    return {
        role: 'user',
        content: [{ type: 'text', text: canonical.text }, ...canonical.attachments],
        timestamp: row.timestamp ?? row.created_at ?? Date.now(),
        genuineUserQueryText: resolveGenuineUserQueryText({ input: message, provenance }),
    };
}
/**
 * The display keeps a user's image as its file, so a recalled one is read
 * and encoded back inline as the Turn that took it sent it (spec 4.3); a
 * model that reads no images gets the request's own placeholder. An image
 * that cannot be read or decoded stays a path reference.
 */
async function inlineRecalledImage(attachment, encoding) {
    const { filePath, mimeType } = attachment;
    if (attachment.dataUrl || !filePath || !mimeType)
        return attachment;
    const candidate = { key: filePath, id: filePath, mime: mimeType, sizeBytes: 0, filePath };
    try {
        const media = await prepareLocalInlineMedia([candidate], { support_image: true }, encoding);
        const image = media.attachments[0];
        return image?.type === 'image'
            ? { ...attachment, dataUrl: `data:${image.mimeType};base64,${image.data}` }
            : attachment;
    }
    catch {
        return attachment;
    }
}
/** A display attachment, structured or in the legacy flat shape, as the Turn's input had it. */
function inputAttachment(value) {
    const attachment = recordOf(value);
    if (!attachment)
        return undefined;
    const meta = recordOf(attachment.meta);
    const local = recordOf(attachment.local);
    const cloud = recordOf(attachment.cloud);
    const fields = {
        type: stringField(meta, 'attachmentType') ?? stringField(attachment, 'type'),
        filePath: stringField(local, 'filePath') ?? stringField(attachment, 'file_path'),
        fileName: stringField(meta, 'fileName') ?? stringField(attachment, 'file_name'),
        mimeType: stringField(meta, 'mimeType') ?? stringField(attachment, 'mime_type'),
        desktopPath: stringField(local, 'desktopPath'),
        dataUrl: stringField(local, 'dataUrl') ??
            stringField(cloud, 'dataUrl') ??
            stringField(attachment, 'data_url'),
        assetId: stringField(local, 'assetId') ?? stringField(attachment, 'asset_id'),
    };
    const present = Object.entries(fields).filter(([, field]) => field !== undefined);
    return present.length > 0 ? Object.fromEntries(present) : undefined;
}
function recordOf(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function stringField(record, key) {
    const value = record?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
//# sourceMappingURL=history-repair.js.map