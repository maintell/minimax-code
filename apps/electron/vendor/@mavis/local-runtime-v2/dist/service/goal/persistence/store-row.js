import { THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON, THREAD_GOAL_STATUSES, THREAD_GOAL_STATUS_REASONS, THREAD_GOAL_WAIT_REASONS, } from '@mavis/goal';
import { readGoalRequestAccounting } from '../accounting/request-projection.js';
import { FULL_USAGE_TOKEN_ACCOUNTING, localRuntimeV2Goals, } from '../../../infra/db/schema/goal.js';
import { logger } from '../../../infra/logging/index.js';
import { THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS } from './store-worker-proposal.js';
/** Read the single Goal row matching `where` and decode it. */
export function readGoalRow(db, where) {
    return withGoalAccounting(db, rowToThreadGoalState(readRawGoalRow(db, where)));
}
export function withGoalAccounting(db, state) {
    return state
        ? { ...state, accounting: readGoalRequestAccounting(db, state.goalId, state.turnsUsed) }
        : undefined;
}
/** Read the raw Goal row matching `where`, for writers that inspect persisted columns. */
export function readRawGoalRow(db, where) {
    return db.select().from(localRuntimeV2Goals).where(where).get();
}
/** Decode listed rows with their accounting, dropping any row that is not a readable Goal. */
export function rowsToThreadGoalStates(db, rows) {
    return rows.flatMap((row) => {
        const state = rowToThreadGoalState(row);
        return state ? [withGoalAccounting(db, state)] : [];
    });
}
const STATUS_SET = new Set(THREAD_GOAL_STATUSES);
const STATUS_REASON_SET = new Set(THREAD_GOAL_STATUS_REASONS);
const WAIT_REASON_SET = new Set(THREAD_GOAL_WAIT_REASONS);
export function rowToThreadGoalState(row) {
    if (!row || !row.goalId || !row.sessionId || !row.objective || !row.status)
        return undefined;
    const status = readStatus(row.status, row.goalId);
    const statusReason = readStatusReason(row.statusReason, row.goalId);
    return {
        goalId: row.goalId,
        sessionId: row.sessionId,
        objective: row.objective,
        objectiveResources: readKickoffAttachments(row.objectiveResourcesJson),
        status,
        createdAt: row.createdAtMs ?? 0,
        updatedAt: row.updatedAtMs,
        // Counters are NOT NULL DEFAULT 0; a negative or non-finite value from a
        // damaged row still surfaces as 0 so the banner never shows NaN.
        tokensUsed: numericOrZero(row.tokensUsed),
        ...readTokenUsage(row),
        turnsUsed: numericOrZero(row.turnsUsed),
        timeUsedSeconds: numericOrZero(row.timeUsedSeconds),
        // NULL or any non-positive budget collapses to `null` (= "no cap") so
        // the banner never displays an absurd `0 / 0` denominator.
        tokenBudget: positiveOrNull(row.tokenBudget),
        replyFingerprint: typeof row.replyFingerprint === 'string' ? row.replyFingerprint : null,
        noProgressStreak: numericOrZero(row.noProgressStreak),
        noToolStreak: numericOrZero(row.noToolStreak),
        lastVerification: readLastVerification(row.lastVerification, row.goalId),
        lastWorkerProposal: readLastWorkerProposal(row.lastWorkerProposal, row.goalId),
        statusReason,
        kickoffAttachments: readKickoffAttachments(row.kickoffAttachmentsJson),
        kickoffState: readKickoffState(row.kickoffState),
        // A wait is only meaningful for an `active` Goal, and only for the exact
        // admission epoch it was decided against. Guarding on both here is what
        // lets every other writer ignore these columns: advancing `updated_at_ms`
        // retires the wait automatically, so a paused -> active transition (or any
        // future epoch writer) can never revive a previous epoch's reason.
        executionWait: status === 'active' && row.executionWaitEpoch === row.updatedAtMs
            ? readExecutionWait(row.executionWaitReason, row.executionWaitSinceMs, row.goalId)
            : null,
        // An account-quota recovery schedule only describes a Goal that is still
        // parked on that exact quota. Forcing `null` for every other state is what
        // makes the column safe to leave behind: a Goal that was paused, cleared,
        // replaced, completed or stopped for a different reason reads as "not
        // auto-recoverable" even if an older row still carries a timestamp.
        usageRecoveryAtMs: readUsageRecoveryAtMs(status, statusReason, row.usageRecoveryAtMs),
        ...readDismissedAt(row.dismissedAtMs),
    };
}
function readDismissedAt(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? { dismissedAt: value }
        : {};
}
function readUsageRecoveryAtMs(status, statusReason, value) {
    if (status !== 'usage_limited')
        return null;
    if (statusReason !== THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON)
        return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        return null;
    return value;
}
export function isKnownThreadGoalStatus(value) {
    return value != null && STATUS_SET.has(value);
}
function readStatus(value, goalId) {
    if (STATUS_SET.has(value))
        return value;
    logger.warn({ goalId, persistedStatus: value }, 'Unknown thread Goal status read fail-closed as paused');
    return 'paused';
}
function readStatusReason(value, goalId) {
    if (value == null)
        return null;
    if (STATUS_REASON_SET.has(value))
        return value;
    logger.warn({ goalId, persistedStatusReason: value }, 'Unknown thread Goal status reason ignored');
    return null;
}
/**
 * Read the persisted wait projection. An unrecognized reason is dropped rather
 * than surfaced, matching `readStatusReason`: an older client seeing a reason
 * minted by a newer runtime degrades to today's behaviour instead of rendering
 * a raw enum string.
 */
function readExecutionWait(reason, sinceMs, goalId) {
    if (reason == null)
        return null;
    if (!WAIT_REASON_SET.has(reason)) {
        logger.warn({ goalId, persistedWaitReason: reason }, 'Unknown thread Goal wait reason ignored');
        return null;
    }
    if (typeof sinceMs !== 'number' || !Number.isSafeInteger(sinceMs) || sinceMs < 0) {
        logger.warn({ goalId, persistedWaitSinceMs: sinceMs }, 'Invalid thread Goal wait time ignored');
        return null;
    }
    return { reason: reason, sinceMs };
}
function readLastVerification(value, goalId) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!isLastVerificationV1(parsed))
            return undefined;
        return {
            v: 1,
            backend: parsed.backend,
            verdict: parsed.verdict,
            reason: parsed.reason,
            missing: [...parsed.missing],
            ...(parsed.missingFingerprint ? { missingFingerprint: parsed.missingFingerprint } : {}),
            notMetStreak: parsed.notMetStreak,
            turnId: parsed.turnId,
            objectiveDigest: parsed.objectiveDigest,
            at: parsed.at,
        };
    }
    catch (error) {
        logger.warn({ goalId, error }, 'Invalid thread Goal verification JSON ignored');
        return undefined;
    }
}
const VERIFICATION_BACKENDS = new Set(['evaluator', 'subagent']);
const VERIFICATION_VERDICTS = new Set([
    'met',
    'not_met',
    'impossible',
    'inconclusive',
]);
const WORKER_PROPOSAL_TYPES = new Set(['complete', 'blocked']);
const KICKOFF_ATTACHMENT_TYPES = new Set(['file', 'image']);
function isLastVerificationV1(value) {
    const item = readPlainRecord(value);
    return (item !== undefined &&
        item.v === 1 &&
        VERIFICATION_BACKENDS.has(item.backend) &&
        VERIFICATION_VERDICTS.has(item.verdict) &&
        typeof item.reason === 'string' &&
        isStringArray(item.missing) &&
        optionalString(item.missingFingerprint) &&
        isNonNegativeInteger(item.notMetStreak) &&
        hasVerificationBinding(item));
}
function hasVerificationBinding(item) {
    return (typeof item.turnId === 'string' &&
        typeof item.objectiveDigest === 'string' &&
        isNonNegativeInteger(item.at));
}
function readLastWorkerProposal(value, goalId) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!isLastWorkerProposalV1(parsed))
            return undefined;
        return {
            v: 1,
            source: 'worker',
            type: parsed.type,
            turnId: parsed.turnId,
            ...(parsed.summary ? { summary: parsed.summary } : {}),
            at: parsed.at,
        };
    }
    catch (error) {
        logger.warn({ goalId, error }, 'Invalid thread Goal worker proposal JSON ignored');
        return undefined;
    }
}
function isLastWorkerProposalV1(value) {
    const item = readPlainRecord(value);
    return (item !== undefined &&
        item.v === 1 &&
        item.source === 'worker' &&
        WORKER_PROPOSAL_TYPES.has(item.type) &&
        typeof item.turnId === 'string' &&
        isBoundedSummary(item.summary) &&
        isNonNegativeInteger(item.at));
}
function isBoundedSummary(value) {
    return (value === undefined ||
        (typeof value === 'string' && value.length <= THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS));
}
function readKickoffState(value) {
    if (value === 'pending' || value === 'enqueued' || value === 'consumed')
        return value;
    return 'consumed';
}
function readKickoffAttachments(value) {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed))
            return [];
        return parsed.flatMap((candidate) => {
            if (!isKickoffAttachment(candidate))
                return [];
            return [{ ...candidate }];
        });
    }
    catch {
        return [];
    }
}
function isKickoffAttachment(value) {
    const item = readPlainRecord(value);
    return (item !== undefined &&
        KICKOFF_ATTACHMENT_TYPES.has(item.type) &&
        typeof item.filePath === 'string' &&
        typeof item.fileName === 'string' &&
        typeof item.mimeType === 'string' &&
        optionalString(item.dataUrl) &&
        optionalString(item.assetId) &&
        optionalString(item.error));
}
function readPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return value;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
}
function optionalString(value) {
    return value === undefined || typeof value === 'string';
}
export function numericOrZero(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        return 0;
    return Math.floor(value);
}
/** Coerce an invalid or absent token budget to the canonical uncapped value. */
export function positiveOrNull(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return null;
    return Math.floor(value);
}
/** Generate the short opaque id used by local Thread Goals. */
export function newThreadGoalId() {
    return `tg_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}
/**
 * The four token parts of a full-usage Goal. A legacy Goal (version 1, every
 * Goal created before migration 48) has none: its usage was never split.
 */
function readTokenUsage(row) {
    if (row.tokenAccountingVersion !== FULL_USAGE_TOKEN_ACCOUNTING)
        return {};
    return {
        tokenUsage: {
            input: numericOrZero(row.inputTokens),
            cacheWrite: numericOrZero(row.cacheWriteTokens),
            cacheRead: numericOrZero(row.cacheReadTokens),
            output: numericOrZero(row.outputTokens),
            ...(row.cacheWriteUnreported ? { cacheWriteUnreported: true } : {}),
        },
    };
}
//# sourceMappingURL=store-row.js.map