import { buildImportedMigrationRecord, buildPhantomMigrationRecord, buildFailedMigrationRecord, } from './legacy-opencode-migration-result.js';
import { countRowsAtOrBefore, isLegacyDisplayReady, isLegacyPiHistoryReady, needsV3Upgrade, } from './legacy-opencode-migration-records.js';
import { NATIVE_PI_HISTORY_CONVERTER_VERSION } from './legacy-opencode-native-conversion.js';
import { detectPostPiCompactionReplacement, } from './legacy-opencode-v3-upgrade.js';
import { DEFAULT_PI_SEED_STRATEGY, } from './legacy-opencode-pi-seed.js';
import { LegacyOpencodeMessageImporter, } from './legacy-opencode-message-importer.js';
import { formatWarningError, logLegacyMigrationInfo, logLegacyMigrationWarn, formatLogValue, normalizeMigratedStatus, buildSourceFingerprint, isUnsafeResumableLegacyStatus, buildSessionStatusWarnings, readSourceSchemaFingerprint, backfillAutoDisplayName, backfillAutoDescription, backfillAutoDefaultWorkspaceDir, mergeWarnings, } from './legacy-opencode-migration-values.js';
const LEGACY_PRIMARY_AGENT_NAME = 'main';
function migrationLayer(options) {
    if (options.includeMessages || options.includePiHistory)
        return 'messages';
    return options.materialize ? 'materialize' : 'discovery';
}
function requestedHistoryReady(record, options) {
    return ((!options.includeMessages || isLegacyDisplayReady(record)) &&
        (!options.includePiHistory || isLegacyPiHistoryReady(record)));
}
export class LegacyOpencodeMigrationError extends Error {
    record;
    cause;
    constructor(record, cause) {
        const causeMessage = cause instanceof Error ? cause.message : String(cause);
        super(`Legacy opencode session migration failed: ${causeMessage}`);
        this.name = 'LegacyOpencodeMigrationError';
        this.record = record;
        this.cause = cause;
    }
}
function throwIfMigrationFailed(record) {
    if (record?.status !== 'failed')
        return;
    throw new LegacyOpencodeMigrationError(record, record.error ?? new Error('Previous legacy opencode session migration failed.'));
}
function logCompletedMigration(sessionId, record, startedAtMs) {
    logLegacyMigrationInfo(`done session=${formatLogValue(sessionId)} status=${formatLogValue(record.status)} sourceCount=${record.sourceMessageCount ?? 0} importedCount=${record.importedMessageCount ?? 0} displayReady=${Boolean(record.displayReadyAtMs)} piHistoryReady=${Boolean(record.piHistoryReadyAtMs)} totalElapsedMs=${Date.now() - startedAtMs} warningsCount=${record.warnings?.length ?? 0}`);
}
export class LegacyOpencodeMigrator {
    legacyStore;
    migrationStore;
    controller;
    messageStore;
    sessionWriter;
    agentStore;
    primaryAgentName;
    defaultWorkspaceDir;
    onPinnedSessionMigrated;
    messageImporter;
    nowMs;
    metrics;
    agentRootRepairInProgress = new Set();
    sourceManifestPromise;
    constructor(options) {
        this.legacyStore = options.legacyStore;
        this.migrationStore = options.migrationStore;
        this.controller = options.controller;
        this.messageStore = options.messageStore;
        this.sessionWriter = options.sessionWriter;
        this.agentStore = options.agentStore;
        this.primaryAgentName = options.primaryAgentName;
        this.defaultWorkspaceDir = options.defaultWorkspaceDir;
        this.onPinnedSessionMigrated = options.onPinnedSessionMigrated;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.metrics = options.metrics;
        this.messageImporter = new LegacyOpencodeMessageImporter({
            legacyStore: this.legacyStore,
            messageStore: this.messageStore,
            sessionWriter: this.sessionWriter,
            dataDir: options.dataDir,
            piSeedStrategy: { ...DEFAULT_PI_SEED_STRATEGY, ...options.piSeedStrategy },
            nowMs: this.nowMs,
        });
    }
    getCachedSourceManifest() {
        this.sourceManifestPromise ??= this.legacyStore.getSourceManifest();
        return this.sourceManifestPromise;
    }
    async listLegacySessions(agentName) {
        const sessions = await this.legacyStore.listSessions(agentName);
        if (agentName === this.primaryAgentName && agentName !== LEGACY_PRIMARY_AGENT_NAME) {
            const aliased = await this.legacyStore.listSessions(LEGACY_PRIMARY_AGENT_NAME);
            const seen = new Set(sessions.map((s) => s.sessionId));
            for (const s of aliased) {
                if (!seen.has(s.sessionId))
                    sessions.push(s);
            }
        }
        if (sessions.length === 0)
            return sessions;
        const deleted = await this.listDeletedLegacySessionIds();
        return sessions.filter((session) => !deleted.has(session.sessionId));
    }
    async getLegacyAgent(agentName) {
        const agent = await this.legacyStore.getAgent(agentName);
        if (!agent && agentName === this.primaryAgentName && agentName !== LEGACY_PRIMARY_AGENT_NAME) {
            return this.legacyStore.getAgent(LEGACY_PRIMARY_AGENT_NAME);
        }
        return agent;
    }
    async migrateSession(legacySessionId, options = {}) {
        const layer = migrationLayer(options);
        const startedMs = this.nowMs();
        try {
            const result = await this.migrateSessionInner(legacySessionId, options);
            this.metrics?.incr('legacy_migration_total', { layer, status: 'ok' });
            this.metrics?.latency('legacy_migration_duration_ms', this.nowMs() - startedMs, { layer });
            return result;
        }
        catch (err) {
            this.metrics?.incr('legacy_migration_total', { layer, status: 'error' });
            throw err;
        }
    }
    async migrateSessionInner(legacySessionId, options = {}) {
        const startedAtMs = Date.now();
        const legacySession = await this.legacyStore.getSession(legacySessionId);
        const canonicalSessionId = legacySession?.sessionId ?? legacySessionId;
        const wantsMaterialize = migrationLayer(options) !== 'discovery';
        logLegacyMigrationInfo(`start session=${formatLogValue(canonicalSessionId)} agent=${formatLogValue(legacySession?.agentName ?? 'unknown')} includeMessages=${Boolean(options.includeMessages)} includePiHistory=${Boolean(options.includePiHistory)} materialize=${wantsMaterialize}`);
        const existingLocal = await this.controller.getSession(canonicalSessionId);
        const existingRecord = await this.migrationStore.getByLegacySessionId(canonicalSessionId);
        if (existingRecord?.status === 'deleted')
            return {};
        throwIfMigrationFailed(existingRecord);
        // Discovery-only path: no local pi-agent row, no agent row, no message
        // import — just a fingerprint row so subsequent list calls short-circuit
        // and mutation calls know where to materialize from. Kept above the
        // main materialize block so a `metadata` / `migrated` record wins
        // without any extra work.
        if (!wantsMaterialize) {
            return this.discoverSession({ legacySession, existingLocal, existingRecord, startedAtMs });
        }
        if (existingLocal?.runtime === 'pi-agent' &&
            existingRecord &&
            requestedHistoryReady(existingRecord, options)) {
            return this.repairExistingMigration(existingLocal, existingRecord, legacySession);
        }
        if (!legacySession) {
            return this.resolveMissingLegacySession(canonicalSessionId, existingLocal, existingRecord, options);
        }
        return this.materializeSession({ legacySession, existingLocal, existingRecord, startedAtMs }, options);
    }
    async discoverSession(input) {
        const { legacySession, existingLocal, existingRecord, startedAtMs } = input;
        if (existingRecord) {
            return { ...(existingLocal ? { session: existingLocal } : {}), record: existingRecord };
        }
        if (!legacySession)
            return {};
        const now = this.nowMs();
        const warnings = buildSessionStatusWarnings(legacySession);
        const record = {
            legacySessionId: legacySession.sessionId,
            localSessionId: legacySession.sessionId,
            legacyDaemonSessionId: legacySession.sessionId,
            legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
            sourceRuntime: 'opencode',
            status: 'discovered',
            migratedAtMs: now,
            sourceUpdatedAtMs: legacySession.updatedAtMs,
            sourceFingerprint: buildSourceFingerprint(legacySession),
            ...(warnings.length ? { warnings } : {}),
        };
        await this.migrationStore.upsert(record);
        logLegacyMigrationInfo(`discovered session=${formatLogValue(legacySession.sessionId)} totalElapsedMs=${Date.now() - startedAtMs}`);
        return { record };
    }
    async repairExistingMigration(session, record, legacySession) {
        if (!legacySession)
            return { session, record };
        return {
            session: await this.repairUnsafeExistingSessionStatus(session, legacySession),
            record: await this.repairSessionStatusWarnings(record, legacySession),
        };
    }
    async resolveMissingLegacySession(canonicalSessionId, existingLocal, existingRecord, options) {
        if (existingLocal?.runtime !== 'pi-agent')
            return {};
        // The agents table also references explicitly created roots. Only repaired
        // shells (or records predating origin) may receive phantom-root history.
        if (existingLocal.sessionType === 'root' &&
            existingLocal.origin !== 'user' &&
            !existingRecord &&
            options.includeMessages) {
            const fallback = await this.migrateReferencedPhantomRoot(canonicalSessionId, existingLocal);
            if (fallback)
                return fallback;
        }
        return { session: existingLocal, record: existingRecord };
    }
    async migrateReferencedPhantomRoot(canonicalSessionId, existingLocal) {
        const legacyAgent = await this.getLegacyAgent(existingLocal.agentName);
        if (legacyAgent?.rootSessionId !== canonicalSessionId)
            return undefined;
        const realRoot = await this.resolvePhantomRootFallback(existingLocal);
        if (realRoot) {
            logLegacyMigrationInfo(`phantom-root-fallback session=${formatLogValue(canonicalSessionId)} realRoot=${formatLogValue(realRoot.sessionId)} agent=${formatLogValue(existingLocal.agentName)}`);
            return this.migratePhantomRoot(existingLocal, realRoot);
        }
        logLegacyMigrationWarn(`phantom-root-no-fallback session=${formatLogValue(canonicalSessionId)} agent=${formatLogValue(existingLocal.agentName)}`);
        return undefined;
    }
    async materializeSession(input, options) {
        const { legacySession, existingLocal, existingRecord, startedAtMs } = input;
        let sourceMessageScan;
        let sourceManifest;
        let sourceSchemaFingerprint = existingRecord?.sourceSchemaFingerprint;
        let sourceMessageCount = existingRecord?.sourceMessageCount;
        try {
            const session = existingLocal?.runtime === 'pi-agent'
                ? existingLocal
                : await this.createMigratedSession(legacySession);
            const messagesNeedImport = Boolean(options.includeMessages && !isLegacyDisplayReady(existingRecord));
            const piHistoryNeedImport = Boolean(options.includePiHistory && !isLegacyPiHistoryReady(existingRecord));
            let messageStats;
            if (messagesNeedImport || piHistoryNeedImport) {
                sourceManifest = await this.getCachedSourceManifest();
                sourceSchemaFingerprint = readSourceSchemaFingerprint(sourceManifest);
                sourceMessageScan ??= await this.legacyStore.scanMessages(legacySession.sessionId);
                sourceMessageCount = sourceMessageScan.sourceCount;
                await this.backfillSessionRecordToLedger(session);
                messageStats = await this.messageImporter.migrateMessages(legacySession, sourceMessageScan, {
                    importDisplay: messagesNeedImport,
                    importPiHistory: piHistoryNeedImport,
                    previousMigratedAtMs: existingRecord?.migratedAtMs,
                });
            }
            const record = buildImportedMigrationRecord({
                legacySession,
                localSessionId: session.sessionId,
                existingRecord,
                messageStats,
                sourceSchemaFingerprint,
                sourceManifest,
                sourceMessageCount,
                messagesNeedImport,
                piHistoryNeedImport,
                now: this.nowMs(),
            });
            await this.migrationStore.upsert(record);
            logCompletedMigration(legacySession.sessionId, record, startedAtMs);
            await this.ensureLocalAgentForSession(session);
            return { session: (await this.controller.getSession(session.sessionId)) ?? session, record };
        }
        catch (err) {
            logLegacyMigrationWarn(`failed session=${formatLogValue(legacySession.sessionId)} err=${formatLogValue(formatWarningError(err))} elapsedMs=${Date.now() - startedAtMs}`);
            const record = buildFailedMigrationRecord({
                legacySession,
                existingRecord,
                sourceSchemaFingerprint,
                sourceManifest,
                sourceMessageScan,
                err,
                now: this.nowMs(),
            });
            await this.migrationStore.upsert(record);
            throw new LegacyOpencodeMigrationError(record, err);
        }
    }
    async ensureMessagesMigrated(sessionId) {
        const record = await this.migrationStore.getByLocalSessionId(sessionId);
        if (isLegacyDisplayReady(record))
            return;
        throwIfMigrationFailed(record);
        if (record?.status === 'deleted')
            return;
        await this.migrateSession(record?.legacySessionId ?? sessionId, { includeMessages: true });
    }
    async ensurePiHistoryMigrated(sessionId) {
        const record = await this.migrationStore.getByLocalSessionId(sessionId);
        if (isLegacyPiHistoryReady(record))
            return;
        throwIfMigrationFailed(record);
        if (record?.status === 'deleted')
            return;
        // v3 upgrade — binary decision (see plan §M3):
        //   scenario A (legacyRowsNow > 0, no compaction artifact)
        //             → full re-migrate legacy segment
        //   scenario B (legacyRowsNow == 0, or pi-agent compaction artifact)
        //             → no-op stamp v3 (pi-history has already been
        //               wholesale replaced by pi-agent compaction; do NOT
        //               resurrect)
        //   scenario D (existing rows == 0) → fresh migration
        //
        // Only take the scenario-B shortcut when the record is a `native-*`
        // strategy stamped by an older converter — the only case that
        // triggered this call in the first place — and pi-history either
        // sits wholly after the previous migration watermark or starts
        // with an explicit pi-agent compaction artifact. If we cannot tell
        // (no watermark on the record, or messageStore isn't wired), fall
        // through to the regular migrate path so the caller's semantics
        // stay intact.
        if (await this.skipCompactedPiHistoryUpgrade(sessionId, record))
            return;
        await this.migrateSession(record?.legacySessionId ?? sessionId, {
            includeMessages: true,
            includePiHistory: true,
        });
    }
    async skipCompactedPiHistoryUpgrade(sessionId, record) {
        if (!this.messageStore || !record || !needsV3Upgrade(record))
            return false;
        const existingRows = await this.messageStore.getPiHistory(sessionId);
        if (existingRows.length === 0)
            return false;
        const migratedAtMs = record.migratedAtMs;
        if (typeof migratedAtMs !== 'number' || !Number.isFinite(migratedAtMs))
            return false;
        const legacyRowsNow = countRowsAtOrBefore(existingRows, migratedAtMs);
        const reason = detectPostPiCompactionReplacement(existingRows, legacyRowsNow);
        if (!reason)
            return false;
        await this.stampV3PostCompactionSkip(record, existingRows.length, legacyRowsNow, reason);
        return true;
    }
    /**
     * Scenario B (see §M3): pi-history has already been fully replaced
     * by pi-agent-side compaction after the original migration wrote its
     * legacy segment. Do NOT resurrect the legacy content — pi-agent
     * runtime is the source of truth for that shape now. Stamp
     * `piHistoryConverterVersion = 3` and leave the rows alone.
     */
    async stampV3PostCompactionSkip(record, existingRowCount, legacyRowsNow, reason) {
        const priorReport = record.report && typeof record.report === 'object' && !Array.isArray(record.report)
            ? record.report
            : {};
        const priorPiHistoryReport = priorReport['piHistory'] &&
            typeof priorReport['piHistory'] === 'object' &&
            !Array.isArray(priorReport['piHistory'])
            ? priorReport['piHistory']
            : {};
        const upgraded = {
            ...record,
            migratedAtMs: this.nowMs(),
            piHistoryConverterVersion: NATIVE_PI_HISTORY_CONVERTER_VERSION,
            warnings: mergeWarnings(record.warnings, [
                `legacy_v3_skipped_post_pi_compaction:${existingRowCount}`,
            ]),
            report: {
                ...priorReport,
                piHistory: {
                    ...priorPiHistoryReport,
                    v3UpgradeDecision: 'skipped-post-pi-compaction',
                    v3UpgradeDetail: {
                        legacyRowsNow,
                        preservedContinuationRows: existingRowCount,
                        reason,
                    },
                },
            },
        };
        await this.migrationStore.upsert(upgraded);
        logLegacyMigrationInfo(`v3-upgrade session=${formatLogValue(record.localSessionId)} decision=skipped-post-pi-compaction legacyRowsNow=${legacyRowsNow} preservedContinuation=${existingRowCount} reason=${reason}`);
    }
    async getMigrationRecordForLocalSession(sessionId) {
        return this.migrationStore.getByLocalSessionId(sessionId);
    }
    async getMigrationRecordForLegacySession(sessionId) {
        return this.migrationStore.getByLegacySessionId(sessionId);
    }
    async listMigrationRecords() {
        return this.migrationStore.listAll();
    }
    async getSourceManifest() {
        return this.getCachedSourceManifest();
    }
    async markSessionDeleted(sessionId) {
        const existingRecord = (await this.migrationStore.getByLocalSessionId(sessionId)) ??
            (await this.migrationStore.getByLegacySessionId(sessionId));
        if (!existingRecord)
            return undefined;
        const record = {
            ...existingRecord,
            status: 'deleted',
            migratedAtMs: this.nowMs(),
            error: undefined,
        };
        await this.migrationStore.upsert(record);
        return record;
    }
    async listDeletedLegacySessionIds() {
        const records = await this.migrationStore.listAll();
        return new Set(records
            .filter((record) => record.status === 'deleted')
            .map((record) => record.legacySessionId));
    }
    async createMigratedSession(legacySession) {
        const session = await this.controller.createPiSession({
            sessionId: legacySession.sessionId,
            agentName: legacySession.agentName,
            workspaceDir: legacySession.workspaceDir || this.defaultWorkspaceDir(),
            sessionType: legacySession.sessionType,
            title: legacySession.title ?? null,
            parentSessionId: legacySession.parentSessionId ?? null,
            visibility: legacySession.visibility,
            purpose: legacySession.purpose,
            archived: legacySession.archived,
            status: normalizeMigratedStatus(legacySession.status, legacySession.legacyRawStatus),
            sessionOrigin: 'legacy-opencode',
            createdAtMs: legacySession.createdAtMs,
            updatedAtMs: legacySession.updatedAtMs,
        });
        if (legacySession.pinned) {
            await this.onPinnedSessionMigrated?.(session.sessionId);
        }
        await this.messageStore?.initSession(session.sessionId);
        return session;
    }
    async repairSessionStatusWarnings(existingRecord, legacySession) {
        const warnings = mergeWarnings(existingRecord.warnings, buildSessionStatusWarnings(legacySession));
        const sameWarnings = warnings?.length === existingRecord.warnings?.length &&
            warnings?.every((warning, index) => warning === existingRecord.warnings?.[index]);
        if (sameWarnings || (!warnings && !existingRecord.warnings))
            return existingRecord;
        const repaired = { ...existingRecord, warnings };
        await this.migrationStore.upsert(repaired);
        return repaired;
    }
    async repairUnsafeExistingSessionStatus(existingLocal, legacySession) {
        if (!isUnsafeResumableLegacyStatus(legacySession.legacyRawStatus ?? legacySession.status)) {
            return existingLocal;
        }
        if (existingLocal.status === 'interrupted')
            return existingLocal;
        return ((await this.controller.updateSession(existingLocal.sessionId, {
            status: 'interrupted',
            errorMessage: 'Legacy session was imported from a non-terminal runtime state and is preserved as interrupted history.',
        })) ?? existingLocal);
    }
    async backfillSessionRecordToLedger(session) {
        await this.sessionWriter.withSessionWriteLock(session.sessionId, async () => {
            const watermark = await this.sessionWriter.recordSessionMetadataUpdated(session);
            await this.sessionWriter.markProjectionWatermark(watermark);
        });
    }
    async ensureLocalAgentForSession(session) {
        if (!this.agentStore || session.agentName === this.primaryAgentName)
            return;
        const existing = await this.agentStore.get(session.agentName);
        const legacyAgent = await this.legacyStore.getAgent(session.agentName);
        const now = this.nowMs();
        if (existing) {
            const rootSessionId = await this.resolveExistingAgentRoot(session, existing, legacyAgent);
            await this.agentStore.upsert({
                ...existing,
                ...this.backfillAgentMetadata(session, existing, legacyAgent),
                rootSessionId,
                updatedAtMs: Math.max(existing.updatedAtMs, session.updatedAtMs, now),
            });
            return;
        }
        const rootSessionId = await this.resolveMigratedRootSessionId(session, legacyAgent?.rootSessionId);
        await this.agentStore.upsert(this.buildMigratedAgent({ session, legacyAgent, rootSessionId, now }));
    }
    buildMigratedAgent(input) {
        const { session, legacyAgent, rootSessionId, now } = input;
        return {
            name: session.agentName,
            displayName: legacyAgent?.displayName ?? session.agentName,
            creationSource: 'auto',
            rootSessionId,
            createdAtMs: legacyAgent?.createdAtMs ?? session.createdAtMs,
            updatedAtMs: Math.max(session.updatedAtMs, now),
            defaultWorkspaceDir: legacyAgent?.defaultWorkspaceDir ?? session.workspaceDir ?? this.defaultWorkspaceDir(),
            description: legacyAgent?.description ?? 'Migrated legacy opencode agent',
            ...(legacyAgent?.avatar ? { avatar: legacyAgent.avatar } : {}),
            ...(legacyAgent?.persona ? { persona: legacyAgent.persona } : {}),
            ...(legacyAgent?.systemPrompt ? { systemPrompt: legacyAgent.systemPrompt } : {}),
        };
    }
    async resolveExistingAgentRoot(session, existing, legacyAgent) {
        const existingRoot = existing.rootSessionId
            ? await this.controller.getSession(existing.rootSessionId)
            : undefined;
        if (existing.rootSessionId && existingRoot?.sessionType === 'root')
            return existing.rootSessionId;
        if (existing.creationSource === 'auto') {
            return this.resolveMigratedRootSessionId(session, legacyAgent?.rootSessionId || existing.rootSessionId);
        }
        return (existing.rootSessionId ||
            (await this.resolveMigratedRootSessionId(session, legacyAgent?.rootSessionId)));
    }
    backfillAgentMetadata(session, existing, legacyAgent) {
        if (existing.creationSource !== 'auto')
            return {};
        return {
            displayName: backfillAutoDisplayName(existing.displayName, legacyAgent?.displayName, session.agentName),
            description: backfillAutoDescription(existing.description, legacyAgent?.description),
            avatar: existing.avatar ?? legacyAgent?.avatar,
            persona: existing.persona ?? legacyAgent?.persona,
            systemPrompt: existing.systemPrompt ?? legacyAgent?.systemPrompt,
            defaultWorkspaceDir: backfillAutoDefaultWorkspaceDir(existing.defaultWorkspaceDir, legacyAgent?.defaultWorkspaceDir, session.workspaceDir, this.defaultWorkspaceDir()),
        };
    }
    async resolveMigratedRootSessionId(session, preferredRootSessionId) {
        if (session.sessionType === 'root')
            return session.sessionId;
        if (this.agentRootRepairInProgress.has(session.agentName))
            return '';
        const legacySessions = await this.legacyStore.listSessions(session.agentName);
        const preferredRoot = preferredRootSessionId
            ? legacySessions.find((candidate) => candidate.sessionType === 'root' &&
                (candidate.sessionId === preferredRootSessionId ||
                    candidate.legacyFrameworkSessionId === preferredRootSessionId))
            : undefined;
        const rootCandidates = [
            preferredRoot,
            ...legacySessions.filter((candidate) => candidate.sessionType === 'root' && candidate.sessionId !== preferredRoot?.sessionId),
        ].filter((candidate) => Boolean(candidate));
        for (const legacyRoot of rootCandidates) {
            const existingRoot = await this.controller.getSession(legacyRoot.sessionId);
            if (existingRoot?.sessionType === 'root')
                return existingRoot.sessionId;
            this.agentRootRepairInProgress.add(session.agentName);
            try {
                // Metadata-only materialization: we need the legacy root's pi-agent
                // session row to exist in the controller so `controller.getSession`
                // below can retrieve it, but we deliberately skip message import.
                // `materialize: true` is required after discovery-only became the
                // default — without it this call would only upsert a
                // `status='discovered'` record and the controller would still return
                // undefined, causing `ensureLocalAgentForSession` to persist an
                // empty rootSessionId onto the agent and later create a fresh
                // empty root through `/agent/:name/session/root` while the real
                // legacy root history sits orphaned.
                await this.migrateSession(legacyRoot.sessionId, {
                    materialize: true,
                    includeMessages: false,
                });
            }
            catch {
                continue;
            }
            finally {
                this.agentRootRepairInProgress.delete(session.agentName);
            }
            const migratedRoot = await this.controller.getSession(legacyRoot.sessionId);
            if (migratedRoot?.sessionType === 'root')
                return migratedRoot.sessionId;
        }
        return '';
    }
    /**
     * For a phantom root session (exists in v2 but not in the legacy sessions
     * table), locate the agent's real legacy root session that actually contains
     * messages. Returns `undefined` when no usable fallback exists.
     */
    async resolvePhantomRootFallback(phantomSession) {
        const agentName = phantomSession.agentName;
        // Reuse listLegacySessions which handles primaryAgent alias merging and
        // deleted-session filtering in one place.
        const liveSessions = (await this.listLegacySessions(agentName));
        if (liveSessions.length === 0)
            return undefined;
        // Prefer legacy roots; among roots pick the one with the most messages.
        const roots = liveSessions.filter((s) => s.sessionType === 'root');
        if (roots.length === 0) {
            logLegacyMigrationWarn(`phantom-root-fallback-from-branch session=${formatLogValue(phantomSession.sessionId)} agent=${formatLogValue(agentName)} candidates=${liveSessions.length}`);
        }
        let best;
        let bestCount = 0;
        for (const candidate of roots.length > 0 ? roots : liveSessions) {
            const scan = await this.legacyStore.scanMessages(candidate.sessionId);
            if (scan.sourceCount > bestCount) {
                best = candidate;
                bestCount = scan.sourceCount;
            }
        }
        return best;
    }
    /**
     * Import messages from a real legacy root session into a phantom root
     * session. The phantom session already exists in v2 as an empty pi-agent
     * root; we reuse it rather than redirecting the agent pointer so cached
     * session IDs in the UI stay valid.
     */
    async migratePhantomRoot(phantomSession, realLegacyRoot) {
        const startedAtMs = Date.now();
        const sourceManifest = await this.getCachedSourceManifest();
        const sourceSchemaFingerprint = readSourceSchemaFingerprint(sourceManifest);
        const sourceMessageScan = await this.legacyStore.scanMessages(realLegacyRoot.sessionId);
        try {
            await this.backfillSessionRecordToLedger(phantomSession);
            // Phantom root is a one-shot special path — always import both display
            // and piHistory in one pass. This avoids the scenario where a first call
            // with includeMessages creates a record, then a second call with
            // includePiHistory skips the phantom branch (because the record exists)
            // and piHistory is never imported.
            // Write only under the phantom ID, keeping the source root available for
            // a later independent migration without orphaned message copies.
            const messageStats = await this.messageImporter.migrateMessagesInto(phantomSession.sessionId, realLegacyRoot, sourceMessageScan, { importDisplay: true, importPiHistory: true });
            const record = buildPhantomMigrationRecord({
                phantomSessionId: phantomSession.sessionId,
                realLegacyRoot,
                messageStats,
                sourceSchemaFingerprint,
                sourceManifest,
                sourceMessageScan,
                now: this.nowMs(),
            });
            await this.migrationStore.upsert(record);
            logLegacyMigrationInfo(`phantom-root-done session=${formatLogValue(phantomSession.sessionId)} realRoot=${formatLogValue(realLegacyRoot.sessionId)} sourceCount=${record.sourceMessageCount ?? 0} importedCount=${record.importedMessageCount ?? 0} displayReady=${Boolean(record.displayReadyAtMs)} piHistoryReady=${Boolean(record.piHistoryReadyAtMs)} totalElapsedMs=${Date.now() - startedAtMs}`);
            return { session: phantomSession, record };
        }
        catch (err) {
            logLegacyMigrationWarn(`phantom-root-failed session=${formatLogValue(phantomSession.sessionId)} realRoot=${formatLogValue(realLegacyRoot.sessionId)} err=${formatLogValue(formatWarningError(err))} elapsedMs=${Date.now() - startedAtMs}`);
            const record = {
                legacySessionId: phantomSession.sessionId,
                localSessionId: phantomSession.sessionId,
                legacyDaemonSessionId: realLegacyRoot.sessionId,
                legacyFrameworkSessionId: realLegacyRoot.legacyFrameworkSessionId,
                sourceRuntime: 'opencode',
                status: 'failed',
                migratedAtMs: this.nowMs(),
                sourceUpdatedAtMs: realLegacyRoot.updatedAtMs,
                sourceFingerprint: buildSourceFingerprint(realLegacyRoot),
                sourceSchemaFingerprint,
                sourceManifest,
                sourceMessageCount: sourceMessageScan.sourceCount,
                error: { message: err instanceof Error ? err.message : String(err) },
            };
            await this.migrationStore.upsert(record);
            throw new LegacyOpencodeMigrationError(record, err);
        }
    }
}
//# sourceMappingURL=legacy-opencode-migrator.js.map