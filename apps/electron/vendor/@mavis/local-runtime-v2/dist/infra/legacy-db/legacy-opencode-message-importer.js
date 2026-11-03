import crypto from 'node:crypto';
import { registerLocalAsset } from '../file/assets-store.js';
import { checksumJson, isLegacyMissingMessageId, isLocalStoreSyntheticMessageId, mergeDisplayMessages, missingIdMessageFingerprint, prepareLegacyDisplayMessages, preferExistingDisplayMessages, sanitizeDisplayMessagesForImport, } from './legacy-opencode-display-transforms.js';
import { filterPostMigrationMessages, readMessageTimestamp, regroupPiAgentMessages, } from './legacy-opencode-migration-records.js';
import { convertNativeMessagesToPiHistory, filterCompactedNativeMessages, NATIVE_PI_HISTORY_CONVERTER_VERSION, } from './legacy-opencode-native-conversion.js';
import { sanitizePiHistoryForMessages } from './pi-history-sanitizer.js';
import { buildPiSeedHistory, } from './legacy-opencode-pi-seed.js';
import { formatWarningError, logLegacyMigrationInfo, logLegacyMigrationWarn, formatLogValue, readReportNumber, describeNativeFallbackReason, hasPiSeedMarker, buildSessionStatusWarnings, buildMessageScanWarnings, } from './legacy-opencode-migration-values.js';
/**
 * Batch bounds for the streamed display-only import path. Source messages are
 * read, transformed, and written in count- and byte-bounded chunks so peak
 * memory scales with the batch rather than the whole session history. Chosen as
 * a balance between transaction overhead (too small → many tiny writes) and
 * resident memory (too large → defeats the point). Not user-configurable.
 */
const LEGACY_DISPLAY_IMPORT_BATCH_SIZE = 250;
const LEGACY_DISPLAY_IMPORT_BATCH_BYTES = 8 * 1024 * 1024;
function supportsStreamedDisplay(options, messageStore) {
    return (options.importDisplay &&
        !options.importPiHistory &&
        typeof messageStore.appendDisplayMessages === 'function');
}
function nativeFailureReport(native) {
    return native?.report ? { nativeFailure: native.report } : {};
}
function buildMessageMigrationReport(input) {
    const { session, sourceMessageScan, options, prepared, piImport } = input;
    return {
        sessionId: session.sessionId,
        ...(input.targetSessionId !== undefined ? { targetSessionId: input.targetSessionId } : {}),
        legacyFrameworkSessionId: session.legacyFrameworkSessionId,
        display: {
            sourceCount: sourceMessageScan.sourceCount,
            parsedCount: input.parsedMessages.length,
            importedCount: options.importDisplay
                ? input.messages.length
                : input.existingDisplayMessages.length,
            duplicateMsgIdsRewritten: prepared.duplicateMsgIdsRewritten,
            missingMsgIdsAssigned: prepared.missingMsgIdsAssigned,
            ready: options.importDisplay,
        },
        piHistory: piImport?.report ?? {
            strategy: options.importPiHistory ? 'existing-seed-preserved' : 'deferred',
            importedMessages: 0,
            ready: false,
        },
        attachments: input.attachmentStats,
        checksums: {
            sourceRaw: sourceMessageScan.rawChecksum,
            sourceParsed: sourceMessageScan.parsedChecksum,
            importedDisplay: checksumJson(input.messages),
        },
    };
}
function buildMessageMigrationStats(input) {
    const { sourceMessageScan, options, piImport, attachmentStats } = input;
    return {
        sourceMessageCount: sourceMessageScan.sourceCount,
        importedMessageCount: options.importDisplay
            ? input.messages.length
            : input.existingDisplayMessages.length,
        sourceChecksum: sourceMessageScan.rawChecksum,
        displayChecksum: checksumJson(input.messages),
        piHistoryStrategy: piImport?.strategy ?? (options.importPiHistory ? 'existing-seed-preserved' : undefined),
        piHistoryConverterVersion: piImport && piImport.strategy.startsWith('native-')
            ? NATIVE_PI_HISTORY_CONVERTER_VERSION
            : undefined,
        displayReady: options.importDisplay,
        piHistoryReady: Boolean(piImport && !piImport.retryable),
        piHistoryFailClosed: Boolean(piImport?.failClosed),
        report: buildMessageMigrationReport(input),
        warnings: [
            ...input.prepared.warnings,
            ...buildMessageScanWarnings(sourceMessageScan),
            ...buildSessionStatusWarnings(input.session),
            ...(piImport?.warnings ?? []),
            ...(attachmentStats.missing > 0
                ? [`legacy_attachment_missing_or_unreadable:${attachmentStats.missing}`]
                : []),
        ],
    };
}
export class LegacyOpencodeMessageImporter {
    legacyStore;
    messageStore;
    sessionWriter;
    dataDir;
    piSeedStrategy;
    nowMs;
    constructor(options) {
        this.legacyStore = options.legacyStore;
        this.messageStore = options.messageStore;
        this.sessionWriter = options.sessionWriter;
        this.dataDir = options.dataDir;
        this.piSeedStrategy = options.piSeedStrategy;
        this.nowMs = options.nowMs;
    }
    /**
     * Streamed, display-only import. Produces byte-for-byte the same persisted
     * display rows (and the same `displayChecksum`) as the array pipeline
     * (`prepareLegacyDisplayMessages` → `preferExistingDisplayMessages` →
     * `normalizeLegacyMessageAttachments` → `mergeDisplayMessages` →
     * `sanitizeDisplayMessagesForImport`), but runs the transforms per message
     * over streamed source pages so peak memory scales with the batch size
     * instead of the whole session history.
     *
     * Only valid when pi-history is NOT being imported in the same round —
     * pi-history conversion consumes the full display array, so streaming would
     * not lower the peak there and the caller keeps the array path.
     *
     * The global-dedup semantics of the array helpers are preserved exactly:
     *   - prepare: a per-run `seenBase` map rewrites duplicate source msg_ids and
     *     assigns synthetic ids to missing ones, in source order (index-based).
     *   - prefer: existing display rows win by msg_id; missing-id legacy rows are
     *     matched to existing synthetic rows by fingerprint, consuming each match
     *     once (`shift`).
     *   - merge tail: existing rows whose msg_id was never emitted are appended
     *     after the legacy stream, in existing order.
     * Building the existing-row indices still reads the already-migrated display
     * set once (as the array path did); the large legacy blob is what streams.
     */
    async streamDisplayImport(sourceSessionId, targetSessionId, messageStore, scannedDuplicateSourceMsgIds) {
        const existingDisplayMessages = await messageStore.getDisplayMessages(targetSessionId);
        const existingById = new Map();
        for (const message of existingDisplayMessages) {
            if (message.msg_id)
                existingById.set(message.msg_id, message);
        }
        const existingSyntheticByFingerprint = new Map();
        for (const message of existingDisplayMessages) {
            if (!isLocalStoreSyntheticMessageId(message.msg_id))
                continue;
            const fingerprint = missingIdMessageFingerprint(message);
            const matches = existingSyntheticByFingerprint.get(fingerprint) ?? [];
            matches.push(message);
            existingSyntheticByFingerprint.set(fingerprint, matches);
        }
        // First-pass dedup state, mirroring `prepareLegacyDisplayMessages`.
        const seenBase = new Map();
        const duplicateSourceMsgIds = await this.collectDuplicateSourceMsgIds(sourceSessionId, scannedDuplicateSourceMsgIds);
        let duplicateMsgIdsRewritten = 0;
        let missingMsgIdsAssigned = 0;
        let sourceIndex = 0;
        // Merge-tail bookkeeping, mirroring `mergeDisplayMessages`: track which
        // msg_ids were emitted from the legacy stream so leftover existing rows can
        // be appended afterwards.
        const emittedMsgIds = new Set();
        const attachmentStats = { missing: 0, copied: 0, dataUrl: 0 };
        const displayHash = crypto.createHash('sha256');
        // `checksumJson(messages)` hashes `JSON.stringify(array)` — reproduce that
        // exactly by feeding the array's JSON delimiters (`[`, `,`, `]`) around
        // each element's JSON so a streamed hash equals the whole-array hash.
        displayHash.update('[');
        let checksumCount = 0;
        let importedMessageCount = 0;
        let parsedCount = 0;
        const prepareOne = (message) => {
            const original = typeof message.msg_id === 'string' && message.msg_id.trim() ? message.msg_id : undefined;
            const base = original ?? `legacy-missing-msg-id-${sourceIndex + 1}`;
            const count = seenBase.get(base) ?? 0;
            seenBase.set(base, count + 1);
            const index = sourceIndex;
            sourceIndex += 1;
            if (!original) {
                missingMsgIdsAssigned += 1;
                return { ...message, msg_id: `${base}-${checksumJson(message).slice(0, 12)}` };
            }
            if (count > 0) {
                duplicateMsgIdsRewritten += 1;
                duplicateSourceMsgIds.add(base);
                return { ...message, msg_id: `${base}__legacy_dup_${count + 1}_${index + 1}` };
            }
            return message;
        };
        const preferOne = (message) => {
            if (message.msg_id) {
                const existing = duplicateSourceMsgIds.has(message.msg_id)
                    ? undefined
                    : existingById.get(message.msg_id);
                if (existing)
                    return existing;
                if (isLegacyMissingMessageId(message.msg_id)) {
                    const matches = existingSyntheticByFingerprint.get(missingIdMessageFingerprint(message));
                    const match = matches?.shift();
                    if (match)
                        return match;
                }
            }
            return message;
        };
        const emit = (message) => {
            if (message.msg_id)
                emittedMsgIds.add(message.msg_id);
            const [sanitized] = sanitizeDisplayMessagesForImport([message]);
            const finalMessage = sanitized ?? message;
            const serialized = JSON.stringify(finalMessage);
            if (checksumCount > 0)
                displayHash.update(',');
            displayHash.update(serialized);
            checksumCount += 1;
            importedMessageCount += 1;
            return { message: finalMessage, bytes: Buffer.byteLength(serialized, 'utf8') };
        };
        // Drive the streamed writer with an async generator that yields our
        // transformed batches, so ledger + message-store writes stay batched and
        // the streamed writer clears existing rows on its first batch. Because
        // `preferOne`/merge-tail reference the pre-existing rows, we snapshot them
        // into `existingById` / `existingDisplayMessages` above, so clearing is safe.
        // The generator is called with the importer as its receiver below.
        const transformedBatches = async function* streamTransformedBatches() {
            let batch = [];
            let batchBytes = 0;
            const enqueue = (emitted) => {
                if (batch.length > 0 && batchBytes + emitted.bytes > LEGACY_DISPLAY_IMPORT_BATCH_BYTES) {
                    const ready = batch;
                    batch = [emitted.message];
                    batchBytes = emitted.bytes;
                    return ready;
                }
                batch.push(emitted.message);
                batchBytes += emitted.bytes;
                if (batch.length >= LEGACY_DISPLAY_IMPORT_BATCH_SIZE ||
                    batchBytes >= LEGACY_DISPLAY_IMPORT_BATCH_BYTES) {
                    const ready = batch;
                    batch = [];
                    batchBytes = 0;
                    return ready;
                }
                return undefined;
            };
            for await (const page of this.legacyStore.streamMessagePages(sourceSessionId, LEGACY_DISPLAY_IMPORT_BATCH_SIZE, LEGACY_DISPLAY_IMPORT_BATCH_BYTES)) {
                parsedCount += page.length;
                const prepared = page.map(prepareOne);
                const preferred = prepared.map(preferOne);
                const normalized = await this.normalizeLegacyMessageAttachments(sourceSessionId, preferred, attachmentStats);
                const emitted = normalized.map(emit);
                page.length = 0;
                prepared.length = 0;
                preferred.length = 0;
                normalized.length = 0;
                for (const message of emitted) {
                    const ready = enqueue(message);
                    if (ready)
                        yield ready;
                }
            }
            // Merge tail: existing rows never emitted from the legacy stream, in
            // existing order (mirrors `mergeDisplayMessages`' trailing loop).
            for (const existingMessage of existingDisplayMessages) {
                if (existingMessage.msg_id && emittedMsgIds.has(existingMessage.msg_id))
                    continue;
                const ready = enqueue(emit(existingMessage));
                if (ready)
                    yield ready;
            }
            if (batch.length > 0)
                yield batch;
        };
        await this.sessionWriter.importDisplayMessagesStreamed(targetSessionId, transformedBatches.call(this));
        displayHash.update(']');
        const displayChecksum = displayHash.digest('hex');
        const warnings = [
            ...(duplicateMsgIdsRewritten > 0
                ? [`legacy_duplicate_msg_id_rewritten:${duplicateMsgIdsRewritten}`]
                : []),
            ...(missingMsgIdsAssigned > 0
                ? [`legacy_missing_msg_id_assigned:${missingMsgIdsAssigned}`]
                : []),
        ];
        return {
            importedMessageCount,
            displayChecksum,
            duplicateMsgIdsRewritten,
            missingMsgIdsAssigned,
            duplicateSourceMsgIds: [...duplicateSourceMsgIds],
            warnings,
            attachmentStats,
            parsedCount,
        };
    }
    async collectDuplicateSourceMsgIds(sourceSessionId, scanned) {
        // Older stores may omit scan duplicates; collect them before any preference
        // decision so a duplicate near the end also protects the first source row.
        const duplicateSourceMsgIds = new Set(scanned ?? []);
        if (scanned !== undefined)
            return duplicateSourceMsgIds;
        const dupSeen = new Map();
        for await (const page of this.legacyStore.streamMessagePages(sourceSessionId, LEGACY_DISPLAY_IMPORT_BATCH_SIZE)) {
            for (const message of page) {
                const original = typeof message.msg_id === 'string' && message.msg_id.trim() ? message.msg_id : undefined;
                if (!original)
                    continue;
                const count = dupSeen.get(original) ?? 0;
                dupSeen.set(original, count + 1);
                if (count > 0)
                    duplicateSourceMsgIds.add(original);
            }
        }
        return duplicateSourceMsgIds;
    }
    async migrateMessages(legacySession, sourceMessageScan, options) {
        if (!this.messageStore) {
            return {
                sourceMessageCount: sourceMessageScan.sourceCount,
                importedMessageCount: 0,
                sourceChecksum: sourceMessageScan.rawChecksum,
                warnings: ['legacy_messages_skipped:no_message_store'],
                retryable: true,
            };
        }
        // Fast path: display-only import (no pi-history this round) with a batched
        // message store. Stream the (potentially huge) legacy blob through a
        // per-message transform pipeline so peak memory scales with the batch size
        // rather than the whole session history. Pi-history conversion needs the
        // full display array, so it keeps the array path below.
        const canStreamDisplay = supportsStreamedDisplay(options, this.messageStore);
        if (canStreamDisplay) {
            const displayStartedAtMs = Date.now();
            const streamed = await this.streamDisplayImport(legacySession.sessionId, legacySession.sessionId, this.messageStore, sourceMessageScan.duplicateSourceMsgIds);
            logLegacyMigrationInfo(`display-import done session=${formatLogValue(legacySession.sessionId)} messages=${streamed.importedMessageCount} streamed=1 elapsedMs=${Date.now() - displayStartedAtMs}`);
            const warnings = [
                ...streamed.warnings,
                ...buildMessageScanWarnings(sourceMessageScan),
                ...buildSessionStatusWarnings(legacySession),
                ...(streamed.attachmentStats.missing > 0
                    ? [`legacy_attachment_missing_or_unreadable:${streamed.attachmentStats.missing}`]
                    : []),
            ];
            const report = {
                sessionId: legacySession.sessionId,
                legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
                display: {
                    sourceCount: sourceMessageScan.sourceCount,
                    parsedCount: streamed.parsedCount,
                    importedCount: streamed.importedMessageCount,
                    duplicateMsgIdsRewritten: streamed.duplicateMsgIdsRewritten,
                    missingMsgIdsAssigned: streamed.missingMsgIdsAssigned,
                    ready: true,
                },
                piHistory: { strategy: 'deferred', importedMessages: 0, ready: false },
                attachments: streamed.attachmentStats,
                checksums: {
                    sourceRaw: sourceMessageScan.rawChecksum,
                    sourceParsed: sourceMessageScan.parsedChecksum,
                    importedDisplay: streamed.displayChecksum,
                },
            };
            return {
                sourceMessageCount: sourceMessageScan.sourceCount,
                importedMessageCount: streamed.importedMessageCount,
                sourceChecksum: sourceMessageScan.rawChecksum,
                displayChecksum: streamed.displayChecksum,
                piHistoryStrategy: undefined,
                piHistoryConverterVersion: undefined,
                displayReady: true,
                piHistoryReady: false,
                piHistoryFailClosed: false,
                report,
                warnings,
            };
        }
        const attachmentStats = { missing: 0, copied: 0, dataUrl: 0 };
        const parsedMessages = options.importDisplay
            ? await this.legacyStore.listMessages(legacySession.sessionId)
            : [];
        const prepared = prepareLegacyDisplayMessages(parsedMessages);
        const existingDisplayMessages = await this.messageStore.getDisplayMessages(legacySession.sessionId);
        const messages = options.importDisplay
            ? await this.normalizeLegacyMessageAttachments(legacySession.sessionId, preferExistingDisplayMessages(prepared.messages, existingDisplayMessages, {
                duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
            }), attachmentStats)
            : existingDisplayMessages;
        if (options.importDisplay) {
            const displayStartedAtMs = Date.now();
            const mergedDisplayMessages = mergeDisplayMessages(messages, existingDisplayMessages, {
                duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
            });
            await this.sessionWriter.importDisplayMessages(legacySession.sessionId, sanitizeDisplayMessagesForImport(mergedDisplayMessages));
            logLegacyMigrationInfo(`display-import done session=${formatLogValue(legacySession.sessionId)} messages=${mergedDisplayMessages.length} elapsedMs=${Date.now() - displayStartedAtMs}`);
        }
        const existingPiHistory = await this.messageStore.getPiHistory(legacySession.sessionId);
        const piImport = options.importPiHistory
            ? await this.buildPiHistory({
                session: legacySession,
                messages,
                sourceMessageScan,
                existingPiHistory,
                previousMigratedAtMs: options.previousMigratedAtMs,
            })
            : undefined;
        if (piImport) {
            const piHistoryStartedAtMs = Date.now();
            await this.sessionWriter.importPiHistory(legacySession.sessionId, piImport.messages);
            logLegacyMigrationInfo(`pi-history-import done session=${formatLogValue(legacySession.sessionId)} strategy=${formatLogValue(piImport.strategy)} messages=${piImport.messages.length} elapsedMs=${Date.now() - piHistoryStartedAtMs}`);
        }
        return buildMessageMigrationStats({
            session: legacySession,
            sourceMessageScan,
            options,
            attachmentStats,
            parsedMessages,
            prepared,
            existingDisplayMessages,
            messages,
            piImport,
        });
    }
    /**
     * Variant of `migrateMessages` that reads from `sourceSession` but writes
     * the imported display / pi-history data under a different `targetSessionId`.
     * Used by phantom-root migration to avoid creating orphaned message copies
     * under the source session ID.
     */
    async migrateMessagesInto(targetSessionId, sourceSession, sourceMessageScan, options) {
        if (!this.messageStore) {
            return {
                sourceMessageCount: sourceMessageScan.sourceCount,
                importedMessageCount: 0,
                sourceChecksum: sourceMessageScan.rawChecksum,
                warnings: ['legacy_messages_skipped:no_message_store'],
                retryable: true,
            };
        }
        // Fast path: display-only import (no pi-history this round) with a batched
        // message store — same streaming rationale as `migrateMessages`, but source
        // and target session ids differ (phantom-root).
        const canStreamDisplay = supportsStreamedDisplay(options, this.messageStore);
        if (canStreamDisplay) {
            const displayStartedAtMs = Date.now();
            const streamed = await this.streamDisplayImport(sourceSession.sessionId, targetSessionId, this.messageStore, sourceMessageScan.duplicateSourceMsgIds);
            logLegacyMigrationInfo(`display-import done session=${formatLogValue(targetSessionId)} (source=${formatLogValue(sourceSession.sessionId)}) messages=${streamed.importedMessageCount} streamed=1 elapsedMs=${Date.now() - displayStartedAtMs}`);
            const warnings = [
                ...streamed.warnings,
                ...buildMessageScanWarnings(sourceMessageScan),
                ...buildSessionStatusWarnings(sourceSession),
                ...(streamed.attachmentStats.missing > 0
                    ? [`legacy_attachment_missing_or_unreadable:${streamed.attachmentStats.missing}`]
                    : []),
            ];
            const report = {
                sessionId: sourceSession.sessionId,
                targetSessionId,
                legacyFrameworkSessionId: sourceSession.legacyFrameworkSessionId,
                display: {
                    sourceCount: sourceMessageScan.sourceCount,
                    parsedCount: streamed.parsedCount,
                    importedCount: streamed.importedMessageCount,
                    duplicateMsgIdsRewritten: streamed.duplicateMsgIdsRewritten,
                    missingMsgIdsAssigned: streamed.missingMsgIdsAssigned,
                    ready: true,
                },
                piHistory: { strategy: 'deferred', importedMessages: 0, ready: false },
                attachments: streamed.attachmentStats,
                checksums: {
                    sourceRaw: sourceMessageScan.rawChecksum,
                    sourceParsed: sourceMessageScan.parsedChecksum,
                    importedDisplay: streamed.displayChecksum,
                },
            };
            return {
                sourceMessageCount: sourceMessageScan.sourceCount,
                importedMessageCount: streamed.importedMessageCount,
                sourceChecksum: sourceMessageScan.rawChecksum,
                displayChecksum: streamed.displayChecksum,
                piHistoryStrategy: undefined,
                piHistoryConverterVersion: undefined,
                displayReady: true,
                piHistoryReady: false,
                piHistoryFailClosed: false,
                report,
                warnings,
            };
        }
        const attachmentStats = { missing: 0, copied: 0, dataUrl: 0 };
        const parsedMessages = options.importDisplay
            ? await this.legacyStore.listMessages(sourceSession.sessionId)
            : [];
        const prepared = prepareLegacyDisplayMessages(parsedMessages);
        const existingDisplayMessages = await this.messageStore.getDisplayMessages(targetSessionId);
        const messages = options.importDisplay
            ? await this.normalizeLegacyMessageAttachments(sourceSession.sessionId, preferExistingDisplayMessages(prepared.messages, existingDisplayMessages, {
                duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
            }), attachmentStats)
            : existingDisplayMessages;
        if (options.importDisplay) {
            const displayStartedAtMs = Date.now();
            const mergedDisplayMessages = mergeDisplayMessages(messages, existingDisplayMessages, {
                duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
            });
            await this.sessionWriter.importDisplayMessages(targetSessionId, sanitizeDisplayMessagesForImport(mergedDisplayMessages));
            logLegacyMigrationInfo(`display-import done session=${formatLogValue(targetSessionId)} (source=${formatLogValue(sourceSession.sessionId)}) messages=${mergedDisplayMessages.length} elapsedMs=${Date.now() - displayStartedAtMs}`);
        }
        const existingPiHistory = await this.messageStore.getPiHistory(targetSessionId);
        const piImport = options.importPiHistory
            ? await this.buildPiHistory({
                session: sourceSession,
                messages,
                sourceMessageScan,
                existingPiHistory,
            })
            : undefined;
        if (piImport) {
            const piHistoryStartedAtMs = Date.now();
            await this.sessionWriter.importPiHistory(targetSessionId, piImport.messages);
            logLegacyMigrationInfo(`pi-history-import done session=${formatLogValue(targetSessionId)} (source=${formatLogValue(sourceSession.sessionId)}) strategy=${formatLogValue(piImport.strategy)} messages=${piImport.messages.length} elapsedMs=${Date.now() - piHistoryStartedAtMs}`);
        }
        return buildMessageMigrationStats({
            session: sourceSession,
            targetSessionId,
            sourceMessageScan,
            options,
            attachmentStats,
            parsedMessages,
            prepared,
            existingDisplayMessages,
            messages,
            piImport,
        });
    }
    async normalizeLegacyMessageAttachments(legacySessionId, messages, stats) {
        const normalized = [];
        for (const message of messages) {
            if (!message.attachments?.length) {
                normalized.push(message);
                continue;
            }
            const attachments = [];
            for (const attachment of message.attachments) {
                attachments.push(await this.normalizeAttachment(legacySessionId, attachment, stats));
            }
            normalized.push({ ...message, attachments });
        }
        return normalized;
    }
    async normalizeAttachment(legacySessionId, attachment, stats) {
        if (attachment.asset_id || (!attachment.file_path && !attachment.data_url))
            return attachment;
        try {
            const asset = await registerLocalAsset({
                dataDir: this.dataDir,
                fileName: attachment.file_name || 'attachment',
                mimeType: attachment.mime_type || 'application/octet-stream',
                sourcePath: attachment.file_path,
                dataUrl: attachment.data_url,
                sourceKind: 'legacy-migration',
                sessionId: legacySessionId,
                nowMs: this.nowMs,
            });
            if (stats)
                stats[attachment.data_url ? 'dataUrl' : 'copied'] += 1;
            return {
                ...attachment,
                file_path: asset.absolutePath,
                file_name: asset.fileName,
                mime_type: asset.mimeType,
                asset_id: asset.assetId,
                data_url: undefined,
            };
        }
        catch {
            if (stats)
                stats.missing += 1;
            return attachment;
        }
    }
    async buildPiHistory(input) {
        const { session, messages, sourceMessageScan, existingPiHistory, previousMigratedAtMs } = input;
        if (hasPiSeedMarker(existingPiHistory, session.sessionId)) {
            logLegacyMigrationInfo(`pi-history strategy=existing-seed-preserved session=${formatLogValue(session.sessionId)}`);
            return {
                messages: existingPiHistory,
                strategy: 'existing-seed-preserved',
                warnings: [],
                report: { strategy: 'existing-seed-preserved', importedMessages: 0, ready: true },
            };
        }
        const native = await this.buildNativePiHistory(session);
        if (native && native.nativeGroups.length > 0) {
            // v3 group-aware merge, replaces round-4's `sort by row-timestamp`
            // approach (see NATIVE_PI_HISTORY_CONVERTER_VERSION doc for the
            // full story). Two invariants held here:
            //
            //   1. **Native segment order is fixed by opencode semantics.**
            //      `filterCompactedNativeMessages` (M0) already emits
            //      `[compaction-user, summary, ...tail, ...post]` — the exact
            //      replay order opencode's own `filterCompacted` guarantees.
            //      The tail messages inside that slice carry older timestamps
            //      than `compaction-user`/`summary`, so a global sort by
            //      `leaderTimestamp` would re-order them to
            //      `[...tail, compaction-user, summary, ...post]` and
            //      undo the whole point of M0 — the migrated pi-history
            //      would no longer replay opencode's compact semantics.
            //      Therefore we NEVER sort inside the native segment.
            //   2. **Preserved continuation is timestamp-driven.** pi-agent
            //      runtime appends rows with wall-clock timestamps > the
            //      watermark, so sorting them by `leaderTimestamp` recovers
            //      chronological order even if a caller wrote them
            //      out-of-order (regression fixture for
            //      `mvs_b78d7432f8b54791898e81b8ede77f43` explicitly plants
            //      reversed rows). Native-segment `.timestamp` is always
            //      `<= migratedAtMs` while preserved `.timestamp` is
            //      strictly `> migratedAtMs`, so a plain `native ++ preserved`
            //      concat is monotonic across the boundary.
            //   3. **Within any group, order is fixed by construction.**
            //      The converter emits `[assistant, toolResult_1, ...,
            //      toolResult_N]` as one PiHistoryGroup;
            //      `regroupPiAgentMessages` on the preserved-continuation
            //      side also greedily binds a run of toolResults to the
            //      preceding assistant. Cross-segment concat / intra-
            //      preserved sort never re-orders rows inside a group —
            //      Messages-compatible `tool_use ↔ tool_result` adjacency stays
            //      intact regardless.
            //
            // Sanitizer scope: applies ONLY to the native segment (rows we
            // just built from opencode.db). preservedContinuation stays
            // untouched — pi-agent runtime owns its own shape, and we must
            // not drop content it wrote after the original migration.
            const sanitizedNative = sanitizePiHistoryForMessages(native.nativeGroups.flatMap((group) => group.messages), { tag: `migration:${session.sessionId}` });
            const sanitizedNativeGroups = regroupPiAgentMessages(sanitizedNative.messages);
            const preservedContinuation = filterPostMigrationMessages(existingPiHistory, previousMigratedAtMs);
            const preservedGroups = regroupPiAgentMessages(preservedContinuation);
            const droppedV1Rows = existingPiHistory.length - preservedContinuation.length;
            // Sort only WITHIN the preserved-continuation segment (stable
            // sort keeps intra-group order intact). Native segment keeps
            // whatever order M0 handed us — never re-sorted.
            const sortedPreservedGroups = [...preservedGroups].sort((a, b) => a.leaderTimestamp - b.leaderTimestamp);
            const mergedGroups = [...sanitizedNativeGroups, ...sortedPreservedGroups];
            const mergedMessages = mergedGroups.flatMap((group) => group.messages);
            logLegacyMigrationInfo(`pi-history strategy=${formatLogValue(native.strategy)} session=${formatLogValue(session.sessionId)} nativeMessages=${readReportNumber(native.report, 'nativeMessages')} imported=${native.messages.length} preservedUserTurns=${preservedContinuation.length} droppedV1Rows=${droppedV1Rows}` +
                ` sanitizerDropped=${sanitizedNative.stats.orphanToolCallDropped +
                    sanitizedNative.stats.orphanToolResultDropped +
                    sanitizedNative.stats.reorderedPairDropped +
                    sanitizedNative.stats.emptyAssistantDropped} compactionFilterWarnings=${native.compactionFilterWarnings.length}`);
            return {
                ...native,
                messages: mergedMessages,
                warnings: [
                    ...native.warnings,
                    ...sanitizedNative.warnings,
                    ...(droppedV1Rows > 0
                        ? [`legacy_v1_tool_call_dropped_rows_replaced:${droppedV1Rows}`]
                        : []),
                    ...(preservedContinuation.length > 0
                        ? [`legacy_user_continuation_preserved:${preservedContinuation.length}`]
                        : []),
                ],
                report: {
                    ...native.report,
                    preservedUserMessages: preservedContinuation.length,
                    droppedV1Rows,
                    sanitizer: sanitizedNative.stats,
                    compactionFilterWarnings: native.compactionFilterWarnings,
                },
            };
        }
        // Fail-closed guard for stale-native upgrade paths (round-5 review
        // P1). If we got here with a previous migration watermark AND the
        // existing pi-history still holds rows below that watermark, those
        // rows are the previous native-* migration's broken output (v1 shape
        // that dropped tool calls, or v2 shape that shuffled call/result
        // adjacency). Falling back to display-seed here would:
        //   1) leave the broken legacy rows in place ([...existingPiHistory,
        //      ...seed.messages] concat semantics),
        //   2) stamp `piHistoryStrategy = 'display-seed-*'` on the record,
        //   3) `isLegacyPiHistoryConverterCurrent` returns true for any
        //      non-native strategy → the record is treated as "current
        //      forever" and no future ensurePiHistoryMigrated call will
        //      ever re-try the native path,
        //   4) permanently lock the 400 in place with no recovery hook.
        // Instead we return `messages: []` (importPiHistoryUnlocked
        // early-returns on empty → existing pi-history rows are physically
        // untouched) + `failClosed: true` (the outer wrap preserves the
        // existing record's watermark / strategy / version so the next
        // ensurePiHistoryMigrated call still sees the stale-native state
        // and can retry once opencode.db comes back). Fresh migrations
        // (previousMigratedAtMs === undefined) and stale upgrades where
        // existingPiHistory holds no legacy rows still get the original
        // display-seed fallback — that path has no broken content to
        // preserve.
        const hasStaleLegacyRows = previousMigratedAtMs !== undefined &&
            existingPiHistory.some((row) => readMessageTimestamp(row) <= previousMigratedAtMs);
        if (hasStaleLegacyRows) {
            const fallbackReason = describeNativeFallbackReason(native);
            logLegacyMigrationWarn(`pi-history fail-closed session=${formatLogValue(session.sessionId)} reason=${formatLogValue(fallbackReason)} legacyRowsPreserved=${existingPiHistory.length}`);
            return {
                messages: [],
                strategy: 'native-degraded',
                warnings: [
                    ...(native?.warnings ?? ['legacy_native_missing_or_unreadable']),
                    `legacy_v3_upgrade_fail_closed:${fallbackReason}:${existingPiHistory.length}`,
                ],
                report: {
                    strategy: 'native-degraded',
                    v3UpgradeDecision: 'fail-closed-native-source-missing',
                    v3UpgradeDetail: {
                        previousMigratedAtMs,
                        legacyRowsPreserved: existingPiHistory.length,
                        nativeFallbackReason: fallbackReason,
                    },
                    ...nativeFailureReport(native),
                },
                retryable: true,
                failClosed: true,
            };
        }
        const seed = await buildPiSeedHistory({
            session,
            messages,
            sourceMessageScan,
            options: this.piSeedStrategy,
            dataDir: this.dataDir,
            nowMs: this.nowMs,
        });
        logLegacyMigrationInfo(`pi-history strategy=display-seed-${formatLogValue(seed.strategy)} session=${formatLogValue(session.sessionId)} fallbackReason=${formatLogValue(describeNativeFallbackReason(native))}`);
        return {
            ...seed,
            strategy: `display-seed-${seed.strategy}`,
            messages: [...existingPiHistory, ...seed.messages],
            warnings: [
                ...(native?.warnings ?? ['legacy_native_missing_or_unreadable']),
                ...seed.warnings,
            ],
            report: {
                ...seed.report,
                strategy: `display-seed-${seed.strategy}`,
                degradedFromNative: true,
                ...nativeFailureReport(native),
            },
        };
    }
    async buildNativePiHistory(session) {
        try {
            const native = await this.legacyStore.listNativeMessages(session);
            if (!native)
                return undefined;
            // M0 — mirror opencode's own `filterCompacted`: drop everything
            // before the last compaction's `tail_start_id`, keeping only
            // `[compaction-user, summary, ...tail, ...post]`. On uncompacted
            // sessions this is identity + zero warnings; on compacted ones it
            // avoids blowing pi-history past the model context window.
            const filtered = filterCompactedNativeMessages(native.messages);
            const converted = convertNativeMessagesToPiHistory(filtered.messages, this.nowMs);
            const convertedFlat = converted.groups.flatMap((group) => group.messages);
            if (convertedFlat.length === 0) {
                return {
                    messages: [],
                    strategy: 'native-degraded',
                    warnings: [...native.warnings, ...filtered.warnings, 'legacy_native_conversion_empty'],
                    report: {
                        strategy: 'native-degraded',
                        nativeMessages: native.messages.length,
                        filteredMessages: filtered.messages.length,
                        importedMessages: 0,
                        losses: converted.losses,
                        counts: converted.counts,
                    },
                    retryable: true,
                    nativeGroups: [],
                    compactionFilterWarnings: filtered.warnings,
                };
            }
            // Quality gate (see docs/opencode-to-pi-agent-migration.html §I8 +
            // 20260712 post-mortem `mvs_5e9f144c61d74d5d9a0cb748461e42a7`): if
            // the native scan saw tool-call parts but conversion produced zero
            // pi-agent toolCall blocks, the runtime would replay a
            // conversation full of "let me check X" prefaces with no tool
            // actions — the exact shape that starved MiniMax-M3 into
            // one-sentence stops. Rather than accept `native-degraded` with a
            // silent loss, we mark the result as retryable so
            // `buildPiHistory` falls through to `display-seed-*` (which at
            // least keeps the user's questions and the assistant's textual
            // answers coherent, at the cost of dropping tool traces). The
            // native `counts` and `warnings` are surfaced on the report so
            // ops still see the loss.
            const toolCallSourceLoss = converted.counts.source.toolCall > 0 && converted.counts.converted.toolCall === 0;
            const strategy = converted.degraded ? 'native-degraded' : 'native-full';
            if (toolCallSourceLoss) {
                return {
                    messages: [],
                    strategy: 'native-degraded',
                    warnings: [
                        ...native.warnings,
                        ...filtered.warnings,
                        ...converted.warnings,
                        `legacy_native_tool_call_dropped_gate:${converted.counts.source.toolCall}`,
                    ],
                    report: {
                        strategy: 'native-degraded',
                        source: {
                            kind: native.source.kind,
                            schemaFingerprint: native.source.schemaFingerprint,
                            nativeSessionId: native.nativeSessionId,
                        },
                        nativeMessages: native.messages.length,
                        filteredMessages: filtered.messages.length,
                        importedMessages: convertedFlat.length,
                        losses: converted.losses,
                        counts: converted.counts,
                        qualityGateFailure: 'tool_call_dropped',
                    },
                    retryable: true,
                    nativeGroups: [],
                    compactionFilterWarnings: filtered.warnings,
                };
            }
            return {
                messages: convertedFlat,
                strategy,
                warnings: [...native.warnings, ...filtered.warnings, ...converted.warnings],
                report: {
                    strategy,
                    source: {
                        kind: native.source.kind,
                        schemaFingerprint: native.source.schemaFingerprint,
                        nativeSessionId: native.nativeSessionId,
                    },
                    nativeMessages: native.messages.length,
                    filteredMessages: filtered.messages.length,
                    importedMessages: convertedFlat.length,
                    losses: converted.losses,
                    counts: converted.counts,
                },
                nativeGroups: converted.groups,
                compactionFilterWarnings: filtered.warnings,
            };
        }
        catch (err) {
            return {
                messages: [],
                strategy: 'native-degraded',
                warnings: [`legacy_native_conversion_failed:${formatWarningError(err)}`],
                report: { strategy: 'native-degraded', error: formatWarningError(err) },
                retryable: true,
                nativeGroups: [],
                compactionFilterWarnings: [],
            };
        }
    }
}
//# sourceMappingURL=legacy-opencode-message-importer.js.map