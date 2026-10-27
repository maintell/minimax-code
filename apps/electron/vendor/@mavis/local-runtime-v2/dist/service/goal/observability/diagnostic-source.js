import { DEFAULT_OBSERVABILITY_REDACTION_POLICY } from '@mavis/shared/local-runtime-diagnostics/redaction';
import { rowToThreadGoalState } from '../persistence/store-row.js';
const MAX_DIAGNOSTIC_GOALS = 200;
const MAX_DIAGNOSTIC_REQUESTS = 500;
/** Request items kept per Goal, newest first; the summary still counts every read row. */
const MAX_DIAGNOSTIC_REQUESTS_PER_GOAL = 5;
/**
 * Builds the consent-only Goal decision artifact. It carries decisions and a
 * summary of the request ledger — never objective text, prompts, transcripts
 * or raw provider receipts — and reading it changes nothing.
 */
export class ThreadGoalDecisionDiagnosticSource {
    readRows;
    id = 'thread-goal-decisions';
    constructor(readRows) {
        this.readRows = readRows;
    }
    describe() {
        return {
            label: 'Thread Goal decision evidence',
            privacy: 'sensitive',
            uploadDefault: 'consent-required',
        };
    }
    async collect(input) {
        const rows = this.readRows({
            sinceMs: input.sinceMs,
            limit: MAX_DIAGNOSTIC_GOALS + 1,
            requestLimit: MAX_DIAGNOSTIC_REQUESTS + 1,
        });
        const requests = rows.requests.slice(0, MAX_DIAGNOSTIC_REQUESTS);
        const items = newestPerGoal(requests, MAX_DIAGNOSTIC_REQUESTS_PER_GOAL);
        const goals = rows.goals
            .slice(0, MAX_DIAGNOSTIC_GOALS)
            .map((row) => rowToThreadGoalState(row))
            .filter((goal) => goal !== undefined)
            .map((goal) => diagnosticGoal(goal, requests, input.sinceMs));
        if (goals.length === 0 && requests.length === 0)
            return [];
        const content = Buffer.from(`${JSON.stringify({
            schemaVersion: 2,
            generatedAtMs: input.nowMs,
            window: { sinceMs: input.sinceMs, untilMs: input.nowMs, selectedBy: 'activity' },
            limits: {
                maxGoals: MAX_DIAGNOSTIC_GOALS,
                maxRequests: MAX_DIAGNOSTIC_REQUESTS,
                maxRequestsPerGoal: MAX_DIAGNOSTIC_REQUESTS_PER_GOAL,
            },
            truncated: {
                goals: rows.goals.length > MAX_DIAGNOSTIC_GOALS,
                requests: rows.requests.length > MAX_DIAGNOSTIC_REQUESTS,
                requestsPerGoal: items.length < requests.length,
            },
            objectiveIncluded: false,
            transcriptIncluded: false,
            promptIncluded: false,
            rawReceiptIncluded: false,
            requestSummary: summarizeRequests(requests),
            goals,
            requests: items.map(diagnosticRequest),
        }, null, 2)}\n`, 'utf-8');
        return [
            {
                name: 'mavis-goal/goal-decision-evidence.json',
                content,
                bytes: content.byteLength,
                source: this.id,
                privacy: 'sensitive',
                uploadDefault: 'consent-required',
            },
        ];
    }
}
function diagnosticGoal(goal, requests, sinceMs) {
    const own = requests.filter((request) => request.goalId === goal.goalId);
    const lastRequestAtMs = own.reduce((latest, request) => Math.max(latest, request.updatedAtMs), 0);
    return DEFAULT_OBSERVABILITY_REDACTION_POLICY.sanitizeFields({
        goalId: goal.goalId,
        sessionId: goal.sessionId,
        status: goal.status,
        statusReason: goal.statusReason,
        createdAtMs: goal.createdAt,
        updatedAtMs: goal.updatedAt,
        // Why this Goal is in the window: its own change or one of its requests.
        lastActivityAtMs: Math.max(goal.updatedAt, lastRequestAtMs),
        selectedBy: goal.updatedAt >= sinceMs ? 'goal_update' : 'request_activity',
        legacyTurns: goal.turnsUsed,
        tokensUsed: goal.tokensUsed,
        // Requests of this Goal read in the window; items beyond the per-Goal cap are left out.
        requestsInWindow: own.length,
        requestItems: Math.min(own.length, MAX_DIAGNOSTIC_REQUESTS_PER_GOAL),
        ...(goal.lastVerification
            ? {
                lastVerification: {
                    backend: goal.lastVerification.backend,
                    verdict: goal.lastVerification.verdict,
                    // Verifier prose quotes the objective and the transcript: only
                    // whether it was given and how many items were missing.
                    reasonPresent: Boolean(goal.lastVerification.reason),
                    missingCount: goal.lastVerification.missing.length,
                    missingFingerprint: goal.lastVerification.missingFingerprint,
                    notMetStreak: goal.lastVerification.notMetStreak,
                    turnId: goal.lastVerification.turnId,
                    objectiveDigest: goal.lastVerification.objectiveDigest,
                    atMs: goal.lastVerification.at,
                },
            }
            : {}),
        ...(goal.lastWorkerProposal
            ? {
                lastWorkerProposal: {
                    source: goal.lastWorkerProposal.source,
                    type: goal.lastWorkerProposal.type,
                    turnId: goal.lastWorkerProposal.turnId,
                    summaryPresent: Boolean(goal.lastWorkerProposal.summary),
                    atMs: goal.lastWorkerProposal.at,
                },
            }
            : {}),
    });
}
/** Keep the newest `limit` rows of every Goal; `rows` arrive newest first. */
function newestPerGoal(rows, limit) {
    const kept = new Map();
    return rows.filter((row) => {
        const count = kept.get(row.goalId) ?? 0;
        kept.set(row.goalId, count + 1);
        return count < limit;
    });
}
/**
 * Requests by delivery: `known` settled with a confirmed send, `unknown`
 * possibly sent before an interruption, `inFlight` not settled yet, `voided`
 * never sent. Receipts by effect: `applied` charged to their Goal,
 * `discarded` dropped with a reason, `usageIncomplete` without full usage.
 */
function summarizeRequests(requests) {
    const count = (predicate) => requests.filter(predicate).length;
    const discardReasons = {};
    for (const row of requests) {
        if (row.phase !== 'discarded')
            continue;
        const reason = row.discardReason ?? 'unknown';
        discardReasons[reason] = (discardReasons[reason] ?? 0) + 1;
    }
    return {
        total: requests.length,
        requests: {
            known: count((row) => row.phase === 'settled' || row.phase === 'discarded'),
            unknown: count((row) => row.phase === 'unresolved'),
            inFlight: count((row) => row.phase === 'reserved' || row.phase === 'dispatching'),
            voided: count((row) => row.phase === 'voided'),
        },
        receipts: {
            applied: count((row) => row.phase === 'settled'),
            discarded: count((row) => row.phase === 'discarded'),
            usageIncomplete: count((row) => row.usageIncomplete),
        },
        discardReasons,
    };
}
function diagnosticRequest(row) {
    return {
        requestId: row.requestId,
        goalId: row.goalId,
        sessionId: row.sessionId,
        turnId: row.turnId,
        kind: row.kind,
        phase: row.phase,
        outcome: row.outcome,
        attempts: row.attempts,
        usage: {
            input: row.inputTokens,
            output: row.outputTokens,
            cacheRead: row.cacheReadTokens,
            cacheWrite: row.cacheWriteTokens,
            incomplete: row.usageIncomplete,
        },
        ...(row.discardReason ? { discardReason: row.discardReason } : {}),
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
    };
}
//# sourceMappingURL=diagnostic-source.js.map