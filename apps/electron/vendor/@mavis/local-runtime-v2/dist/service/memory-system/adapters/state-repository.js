import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { memoryV2BaselineFiles, memoryV2CaptureAttempts, memoryV2Scopes, memoryV2SessionStates, } from '../../../infra/db/schema/memory-v2.js';
export class MemoryStateRepositoryImpl {
    db;
    nowMs;
    constructor(db, nowMs = Date.now) {
        this.db = db;
        this.nowMs = nowMs;
    }
    async ensureScope(scopeKey) {
        const now = this.nowMs();
        this.db
            .insert(memoryV2Scopes)
            .values({
            scopeKey,
            resetEpoch: 0,
            resetAtMs: 0,
            createdAtMs: now,
            updatedAtMs: now,
        })
            .onConflictDoNothing()
            .run();
        return requireScope(this.db, scopeKey);
    }
    async markGovernanceChange(scopeKey) {
        markGovernanceChange(this.db, scopeKey);
    }
    async getScope(scopeKey) {
        const row = this.db
            .select()
            .from(memoryV2Scopes)
            .where(eq(memoryV2Scopes.scopeKey, scopeKey))
            .get();
        return row ? decodeScopeRow(row) : undefined;
    }
    async hasSessionStates(scopeKey) {
        const row = this.db
            .select({ sessionId: memoryV2SessionStates.sessionId })
            .from(memoryV2SessionStates)
            .where(eq(memoryV2SessionStates.scopeKey, scopeKey))
            .limit(1)
            .get();
        return row !== undefined;
    }
    async getSessionState(scopeKey, sessionId) {
        const row = this.db
            .select()
            .from(memoryV2SessionStates)
            .where(and(eq(memoryV2SessionStates.scopeKey, scopeKey), eq(memoryV2SessionStates.sessionId, sessionId)))
            .get();
        return row ? decodeSessionStateRow(row) : undefined;
    }
    async commitCapture(input) {
        return this.db.transaction((tx) => {
            const scope = tx
                .select()
                .from(memoryV2Scopes)
                .where(eq(memoryV2Scopes.scopeKey, input.scopeKey))
                .get();
            const current = tx
                .select()
                .from(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                .get();
            if (captureCommitConflict(scope, current, input))
                return 'stale-input';
            const now = this.nowMs();
            const payload = captureStatePayload(input);
            if (current) {
                tx.update(memoryV2SessionStates)
                    .set({ ...payload, updatedAtMs: now })
                    .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                    .run();
            }
            else {
                tx.insert(memoryV2SessionStates)
                    .values({
                    scopeKey: input.scopeKey,
                    sessionId: input.sessionId,
                    ...payload,
                    createdAtMs: now,
                    updatedAtMs: now,
                })
                    .run();
            }
            tx.delete(memoryV2CaptureAttempts)
                .where(and(eq(memoryV2CaptureAttempts.scopeKey, input.scopeKey), eq(memoryV2CaptureAttempts.sessionId, input.sessionId)))
                .run();
            return 'committed';
        }, { behavior: 'immediate' });
    }
    async createAdHocNote(input) {
        return this.db.transaction((tx) => {
            const scope = tx
                .select()
                .from(memoryV2Scopes)
                .where(eq(memoryV2Scopes.scopeKey, input.scopeKey))
                .get();
            if (!scope || scope.resetEpoch !== input.expectedResetEpoch)
                return 'stale-epoch';
            const current = tx
                .select()
                .from(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                .get();
            if (current)
                return current.sourceDigest === input.sourceDigest &&
                    current.exclusionReason === null &&
                    current.content !== null
                    ? 'unchanged'
                    : 'conflicting-call';
            const now = this.nowMs();
            tx.insert(memoryV2SessionStates)
                .values({
                scopeKey: input.scopeKey,
                sessionId: input.sessionId,
                ...captureStatePayload(input),
                createdAtMs: now,
                updatedAtMs: now,
            })
                .run();
            return 'committed';
        }, { behavior: 'immediate' });
    }
    async listAdHocNotes(scopeKey) {
        const scope = await this.getScope(scopeKey);
        if (!scope)
            return [];
        return this.db
            .select()
            .from(memoryV2SessionStates)
            .where(and(eq(memoryV2SessionStates.scopeKey, scopeKey), sql `${memoryV2SessionStates.sessionId} like 'note-%'`, gt(memoryV2SessionStates.sessionCreatedAtMs, scope.resetAtMs), isNull(memoryV2SessionStates.exclusionReason), isNotNull(memoryV2SessionStates.content), sql `${memoryV2SessionStates.content} <> ''`))
            .orderBy(asc(memoryV2SessionStates.capturedAtMs), asc(memoryV2SessionStates.sessionId))
            .all()
            .map(decodeSessionStateRow);
    }
    async recordCaptureFailure(input) {
        this.db.transaction((tx) => {
            const current = tx
                .select()
                .from(memoryV2CaptureAttempts)
                .where(and(eq(memoryV2CaptureAttempts.scopeKey, input.scopeKey), eq(memoryV2CaptureAttempts.sessionId, input.sessionId)))
                .get();
            const attempts = current && current.sourceRevision === input.sourceRevision ? current.attempts + 1 : 1;
            tx.insert(memoryV2CaptureAttempts)
                .values({
                scopeKey: input.scopeKey,
                sessionId: input.sessionId,
                sourceRevision: input.sourceRevision,
                attempts,
                lastReason: input.reason,
                retryAtMs: input.retryAtMs,
                updatedAtMs: input.nowMs,
            })
                .onConflictDoUpdate({
                target: [memoryV2CaptureAttempts.scopeKey, memoryV2CaptureAttempts.sessionId],
                set: {
                    sourceRevision: input.sourceRevision,
                    attempts,
                    lastReason: input.reason,
                    retryAtMs: input.retryAtMs,
                    updatedAtMs: input.nowMs,
                },
            })
                .run();
        }, { behavior: 'immediate' });
    }
    async listCaptureAttempts(scopeKey) {
        return this.db
            .select()
            .from(memoryV2CaptureAttempts)
            .where(eq(memoryV2CaptureAttempts.scopeKey, scopeKey))
            .all()
            .map(decodeCaptureAttemptRow);
    }
    async selectCurrentSessions(input) {
        const rows = this.db
            .select()
            .from(memoryV2SessionStates)
            .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), isNull(memoryV2SessionStates.exclusionReason), gt(memoryV2SessionStates.sessionCreatedAtMs, input.createdAfterMs), sql `${memoryV2SessionStates.sessionId} not like 'note-%'`, sql `${memoryV2SessionStates.content} <> ''`, isNotNull(memoryV2SessionStates.content)))
            .orderBy(desc(sql `coalesce(${memoryV2SessionStates.lastUsedAtMs}, ${memoryV2SessionStates.capturedAtMs})`), desc(memoryV2SessionStates.capturedAtMs), asc(memoryV2SessionStates.sessionId))
            .limit(input.maxSessions)
            .all();
        return rows.map(decodeSessionStateRow);
    }
    async commitConsolidation(input) {
        return this.db.transaction((tx) => {
            const scope = tx
                .select()
                .from(memoryV2Scopes)
                .where(eq(memoryV2Scopes.scopeKey, input.scopeKey))
                .get();
            if (!scope || scope.resetEpoch !== input.expectedResetEpoch)
                return 'stale-input';
            const notes = tx
                .select({
                sessionId: memoryV2SessionStates.sessionId,
                outputDigest: memoryV2SessionStates.outputDigest,
            })
                .from(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), sql `${memoryV2SessionStates.sessionId} like 'note-%'`, gt(memoryV2SessionStates.sessionCreatedAtMs, scope.resetAtMs), isNull(memoryV2SessionStates.exclusionReason), isNotNull(memoryV2SessionStates.content), sql `${memoryV2SessionStates.content} <> ''`))
                .all();
            const expectedNotes = new Map(input.expectedSelection
                .filter((row) => row.sessionId.startsWith('note-'))
                .map((row) => [row.sessionId, row.outputDigest]));
            if (notes.length !== expectedNotes.size ||
                notes.some((row) => expectedNotes.get(row.sessionId) !== row.outputDigest))
                return 'stale-input';
            for (const expected of input.expectedSelection) {
                const row = tx
                    .select({ outputDigest: memoryV2SessionStates.outputDigest })
                    .from(memoryV2SessionStates)
                    .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, expected.sessionId)))
                    .get();
                if (!row || row.outputDigest !== expected.outputDigest)
                    return 'stale-input';
            }
            const now = this.nowMs();
            tx.update(memoryV2Scopes)
                .set({
                consolidatedDigest: input.inputDigest,
                consolidatedGovernanceRevision: scope.governanceRevision,
                lastConsolidatedAtMs: input.consolidatedAtMs,
                updatedAtMs: now,
            })
                .where(and(eq(memoryV2Scopes.scopeKey, input.scopeKey), eq(memoryV2Scopes.resetEpoch, input.expectedResetEpoch)))
                .run();
            tx.delete(memoryV2BaselineFiles)
                .where(eq(memoryV2BaselineFiles.scopeKey, input.scopeKey))
                .run();
            for (let offset = 0; offset < input.baselineFiles.length; offset += 100) {
                tx.insert(memoryV2BaselineFiles)
                    .values(input.baselineFiles.slice(offset, offset + 100).map((file) => ({
                    scopeKey: input.scopeKey,
                    fileName: file.fileName,
                    content: file.content,
                    updatedAtMs: input.consolidatedAtMs,
                })))
                    .run();
            }
            return 'committed';
        }, { behavior: 'immediate' });
    }
    async listBaselineFiles(scopeKey) {
        return this.db
            .select({
            fileName: memoryV2BaselineFiles.fileName,
            content: memoryV2BaselineFiles.content,
        })
            .from(memoryV2BaselineFiles)
            .where(eq(memoryV2BaselineFiles.scopeKey, scopeKey))
            .orderBy(asc(memoryV2BaselineFiles.fileName))
            .all();
    }
    async applyContentEdit(input) {
        return this.db.transaction((tx) => {
            const scope = tx
                .select()
                .from(memoryV2Scopes)
                .where(eq(memoryV2Scopes.scopeKey, input.scopeKey))
                .get();
            if (!scope || scope.resetEpoch !== input.expectedResetEpoch)
                return 'stale-input';
            const state = tx
                .select()
                .from(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                .get();
            if (!state || state.outputDigest !== input.expectedOutputDigest)
                return 'stale-input';
            const forgetRules = mergeForgetRules(state.forgetRules, input.appendForgetRule);
            tx.update(memoryV2SessionStates)
                .set({
                content: input.newContent ?? null,
                outputDigest: input.newOutputDigest,
                forgetRules,
                exclusionReason: input.exclusionReason === undefined ? state.exclusionReason : input.exclusionReason,
                updatedAtMs: input.updatedAtMs,
            })
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                .run();
            markGovernanceChange(tx, input.scopeKey);
            return 'committed';
        }, { behavior: 'immediate' });
    }
    async resetScope(input) {
        return this.db.transaction((tx) => {
            const scope = requireScope(tx, input.scopeKey);
            const newEpoch = scope.resetEpoch + 1;
            const newResetAtMs = Math.max(scope.resetAtMs, input.requestedAtMs);
            const now = this.nowMs();
            tx.delete(memoryV2SessionStates)
                .where(eq(memoryV2SessionStates.scopeKey, input.scopeKey))
                .run();
            tx.delete(memoryV2CaptureAttempts)
                .where(eq(memoryV2CaptureAttempts.scopeKey, input.scopeKey))
                .run();
            tx.delete(memoryV2BaselineFiles)
                .where(eq(memoryV2BaselineFiles.scopeKey, input.scopeKey))
                .run();
            tx.update(memoryV2Scopes)
                .set({
                resetEpoch: newEpoch,
                resetAtMs: newResetAtMs,
                consolidatedDigest: null,
                lastConsolidatedAtMs: null,
                updatedAtMs: now,
            })
                .where(eq(memoryV2Scopes.scopeKey, input.scopeKey))
                .run();
            return {
                scopeKey: input.scopeKey,
                resetEpoch: newEpoch,
                resetAtMs: newResetAtMs,
            };
        }, { behavior: 'immediate' });
    }
    async excludeSession(input) {
        return this.db.transaction((tx) => {
            const scope = tx
                .select()
                .from(memoryV2Scopes)
                .where(eq(memoryV2Scopes.scopeKey, input.scopeKey))
                .get();
            if (!scope)
                return 'stale-input';
            const current = tx
                .select()
                .from(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                .get();
            if (current) {
                if (current.sourceRevision !== (input.expectedSourceRevision ?? null))
                    return 'stale-input';
                tx.update(memoryV2SessionStates)
                    .set({
                    exclusionReason: input.reason,
                    content: null,
                    updatedAtMs: input.updatedAtMs,
                })
                    .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                    .run();
            }
            else {
                if (input.expectedSourceRevision !== undefined)
                    return 'stale-input';
                tx.insert(memoryV2SessionStates)
                    .values({
                    scopeKey: input.scopeKey,
                    sessionId: input.sessionId,
                    sessionCreatedAtMs: 0,
                    sourceRevision: '',
                    sourceDigest: '',
                    captureContractId: '',
                    outputDigest: '',
                    content: null,
                    capturedAtMs: 0,
                    exclusionReason: input.reason,
                    createdAtMs: input.updatedAtMs,
                    updatedAtMs: input.updatedAtMs,
                })
                    .run();
            }
            markGovernanceChange(tx, input.scopeKey);
            return 'committed';
        }, { behavior: 'immediate' });
    }
    async deleteSessionState(input) {
        return this.db.transaction((tx) => {
            tx.delete(memoryV2CaptureAttempts)
                .where(and(eq(memoryV2CaptureAttempts.scopeKey, input.scopeKey), eq(memoryV2CaptureAttempts.sessionId, input.sessionId)))
                .run();
            const result = tx
                .delete(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, input.sessionId)))
                .run();
            if (changes(result) > 0)
                markGovernanceChange(tx, input.scopeKey);
            return changes(result) > 0 ? 'updated' : 'unchanged';
        }, { behavior: 'immediate' });
    }
    async recordUsage(input) {
        const sessionIds = [...new Set(input.sourceSessionIds)].sort();
        if (sessionIds.length === 0)
            return { updated: 0, ignored: 0 };
        return this.db.transaction((tx) => {
            let updated = 0;
            let ignored = 0;
            for (const sessionId of sessionIds) {
                const row = tx
                    .select({ sessionId: memoryV2SessionStates.sessionId })
                    .from(memoryV2SessionStates)
                    .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, sessionId), isNull(memoryV2SessionStates.exclusionReason)))
                    .get();
                if (!row) {
                    ignored += 1;
                    continue;
                }
                tx.update(memoryV2SessionStates)
                    .set({
                    lastUsedAtMs: sql `CASE
                WHEN ${memoryV2SessionStates.lastUsedAtMs} IS NULL
                  OR ${memoryV2SessionStates.lastUsedAtMs} < ${input.usedAtMs}
                THEN ${input.usedAtMs}
                ELSE ${memoryV2SessionStates.lastUsedAtMs}
              END`,
                    updatedAtMs: this.nowMs(),
                })
                    .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), eq(memoryV2SessionStates.sessionId, sessionId)))
                    .run();
                updated += 1;
            }
            return { updated, ignored };
        }, { behavior: 'immediate' });
    }
    async listExpiredSessionCandidates(input) {
        const cutoff = input.nowMs - input.retentionDays * 86_400_000;
        return this.db
            .select({
            scopeKey: memoryV2SessionStates.scopeKey,
            sessionId: memoryV2SessionStates.sessionId,
        })
            .from(memoryV2SessionStates)
            .where(and(isNull(memoryV2SessionStates.exclusionReason), or(and(sql `${memoryV2SessionStates.lastUsedAtMs} IS NOT NULL`, lt(memoryV2SessionStates.lastUsedAtMs, cutoff)), and(isNull(memoryV2SessionStates.lastUsedAtMs), lt(memoryV2SessionStates.capturedAtMs, cutoff)))))
            .orderBy(asc(memoryV2SessionStates.scopeKey), asc(memoryV2SessionStates.sessionId))
            .limit(input.limit)
            .all()
            .map((r) => ({ scopeKey: r.scopeKey, sessionId: r.sessionId }));
    }
    async pruneExpired(input) {
        if (input.sessionIds.length === 0)
            return { prunedSessionIds: [] };
        return this.db.transaction((tx) => {
            const eligible = tx
                .select({ sessionId: memoryV2SessionStates.sessionId })
                .from(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), inArray(memoryV2SessionStates.sessionId, [...input.sessionIds]), isNull(memoryV2SessionStates.exclusionReason), or(and(sql `${memoryV2SessionStates.lastUsedAtMs} IS NOT NULL`, lt(memoryV2SessionStates.lastUsedAtMs, input.cutoffAtMs)), and(isNull(memoryV2SessionStates.lastUsedAtMs), lt(memoryV2SessionStates.capturedAtMs, input.cutoffAtMs)))))
                .all()
                .map((r) => r.sessionId);
            if (eligible.length === 0)
                return { prunedSessionIds: [] };
            tx.delete(memoryV2CaptureAttempts)
                .where(and(eq(memoryV2CaptureAttempts.scopeKey, input.scopeKey), inArray(memoryV2CaptureAttempts.sessionId, eligible)))
                .run();
            tx.delete(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, input.scopeKey), inArray(memoryV2SessionStates.sessionId, eligible)))
                .run();
            markGovernanceChange(tx, input.scopeKey);
            return { prunedSessionIds: eligible };
        }, { behavior: 'immediate' });
    }
    async listReconciliationWork(_nowMs) {
        const allScopes = this.db.select().from(memoryV2Scopes).all();
        const activeScopes = allScopes.map((s) => s.scopeKey);
        const scopesNeedingConsolidation = [];
        const scopesNeedingFileCleanup = [];
        for (const scope of allScopes) {
            const hasEligibleSessions = this.db
                .select({ n: sql `1` })
                .from(memoryV2SessionStates)
                .where(and(eq(memoryV2SessionStates.scopeKey, scope.scopeKey), isNull(memoryV2SessionStates.exclusionReason), isNotNull(memoryV2SessionStates.content), gt(memoryV2SessionStates.sessionCreatedAtMs, scope.resetAtMs)))
                .limit(1)
                .get();
            if (scopeNeedsConsolidation(this.db, scope, Boolean(hasEligibleSessions))) {
                scopesNeedingConsolidation.push(scope.scopeKey);
            }
            if (scope.resetAtMs > 0 && scope.consolidatedDigest === null) {
                scopesNeedingFileCleanup.push(scope.scopeKey);
            }
        }
        return {
            scopesNeedingConsolidation,
            scopesNeedingGovernance: allScopes
                .filter((s) => s.governanceRevision !== s.consolidatedGovernanceRevision)
                .map((s) => s.scopeKey),
            activeScopes,
            scopesNeedingFileCleanup,
        };
    }
}
/** commitCapture 写入的行载荷；update 与 insert 共用，undefined 统一落 NULL。 */
function captureStatePayload(input) {
    return {
        sessionCreatedAtMs: input.sessionCreatedAtMs,
        sourceRevision: input.sourceRevision,
        sourceDigest: input.sourceDigest,
        captureContractId: input.captureContractId,
        outputDigest: input.outputDigest,
        content: input.content ?? null,
        agentName: input.agentName ?? null,
        projectName: input.projectName ?? null,
        workspaceDir: input.workspaceDir ?? null,
        capturedAtMs: input.capturedAtMs,
    };
}
/** commitCapture 的条件检查：任一不满足即 stale-input（§5.12），不区分冲突原因。 */
function captureCommitConflict(scope, current, input) {
    if (!scope || scope.resetEpoch !== input.expectedResetEpoch)
        return true;
    if (input.sessionCreatedAtMs <= scope.resetAtMs)
        return true;
    if (current) {
        if (current.exclusionReason !== null)
            return true;
        return current.sourceRevision !== (input.expectedSourceRevision ?? null);
    }
    return input.expectedSourceRevision !== undefined;
}
/** 规则只追加不改写；无既有规则时新规则即全文（§5.8）。 */
function mergeForgetRules(existing, appended) {
    if (appended === undefined)
        return existing;
    return existing === null ? appended : `${existing}\n${appended}`;
}
function scopeNeedsConsolidation(db, scope, hasEligibleSessions) {
    if (!hasEligibleSessions)
        return scope.consolidatedDigest !== null;
    if (scope.consolidatedDigest === null)
        return true;
    if (scope.lastConsolidatedAtMs === null)
        return false;
    // 同一毫秒内发布后新增的 note 仍需进入下一轮；基线成员关系独立于时钟。
    const newNote = db
        .select({ n: sql `1` })
        .from(memoryV2SessionStates)
        .where(and(eq(memoryV2SessionStates.scopeKey, scope.scopeKey), sql `${memoryV2SessionStates.sessionId} like 'note-%'`, gt(memoryV2SessionStates.sessionCreatedAtMs, scope.resetAtMs), isNull(memoryV2SessionStates.exclusionReason), isNotNull(memoryV2SessionStates.content), sql `${memoryV2SessionStates.content} <> ''`, sql `not exists (select 1 from ${memoryV2BaselineFiles} where ${memoryV2BaselineFiles.scopeKey} = ${memoryV2SessionStates.scopeKey} and ${memoryV2BaselineFiles.fileName} = 'extensions/ad_hoc/notes/' || ${memoryV2SessionStates.sessionId} || '.md')`))
        .limit(1)
        .get();
    if (newNote)
        return true;
    const newer = db
        .select({ n: sql `1` })
        .from(memoryV2SessionStates)
        .where(and(eq(memoryV2SessionStates.scopeKey, scope.scopeKey), gt(memoryV2SessionStates.updatedAtMs, scope.lastConsolidatedAtMs)))
        .limit(1)
        .get();
    return Boolean(newer);
}
function requireScope(db, scopeKey) {
    const row = db.select().from(memoryV2Scopes).where(eq(memoryV2Scopes.scopeKey, scopeKey)).get();
    if (!row)
        throw new Error(`Scope not found: ${scopeKey}`);
    return decodeScopeRow(row);
}
function decodeScopeRow(row) {
    return {
        scopeKey: row.scopeKey,
        resetEpoch: row.resetEpoch,
        governanceRevision: row.governanceRevision,
        consolidatedGovernanceRevision: row.consolidatedGovernanceRevision,
        resetAtMs: row.resetAtMs,
        consolidatedDigest: row.consolidatedDigest ?? undefined,
        lastConsolidatedAtMs: row.lastConsolidatedAtMs ?? undefined,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
    };
}
function decodeSessionStateRow(row) {
    return {
        scopeKey: row.scopeKey,
        sessionId: row.sessionId,
        sessionCreatedAtMs: row.sessionCreatedAtMs,
        sourceRevision: row.sourceRevision,
        sourceDigest: row.sourceDigest,
        captureContractId: row.captureContractId,
        outputDigest: row.outputDigest,
        content: row.content ?? undefined,
        forgetRules: row.forgetRules ?? undefined,
        agentName: row.agentName ?? undefined,
        projectName: row.projectName ?? undefined,
        workspaceDir: row.workspaceDir ?? undefined,
        capturedAtMs: row.capturedAtMs,
        lastUsedAtMs: row.lastUsedAtMs ?? undefined,
        exclusionReason: row.exclusionReason ?? undefined,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
    };
}
function decodeCaptureAttemptRow(row) {
    return {
        scopeKey: row.scopeKey,
        sessionId: row.sessionId,
        sourceRevision: row.sourceRevision,
        attempts: row.attempts,
        lastReason: row.lastReason ?? undefined,
        retryAtMs: row.retryAtMs,
        updatedAtMs: row.updatedAtMs,
    };
}
function changes(result) {
    return result.changes;
}
/** 治理版本与事实变更同事务推进，普通采集和使用记账保持原水位。 */
function markGovernanceChange(db, scopeKey) {
    db.update(memoryV2Scopes)
        .set({ governanceRevision: sql `${memoryV2Scopes.governanceRevision} + 1` })
        .where(eq(memoryV2Scopes.scopeKey, scopeKey))
        .run();
}
//# sourceMappingURL=state-repository.js.map