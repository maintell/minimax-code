import fs from 'node:fs';
import { DEFAULT_OBSERVABILITY_REDACTION_POLICY } from '../observability/redaction.js';
import { loadBetterSqlite3Module } from '../persistence/better-sqlite3-loader.js';
import { resolveLocalRuntimeDbPath, } from '../persistence/db.js';
import { rowToThreadGoalState } from './store-row.js';
const MAX_DIAGNOSTIC_GOALS = 200;
/** Builds the consent-only Goal decision artifact without copying objective or transcript text. */
export class ThreadGoalDecisionDiagnosticSource {
    dataDir;
    id = 'thread-goal-decisions';
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    describe() {
        return {
            label: 'Thread Goal decision evidence',
            privacy: 'sensitive',
            uploadDefault: 'consent-required',
        };
    }
    async collect(input) {
        const dbPath = resolveLocalRuntimeDbPath(this.dataDir);
        if (!fs.existsSync(dbPath))
            return [];
        const Database = loadBetterSqlite3Module();
        let db;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
            if (!hasThreadGoalTable(db))
                return [];
            const rows = db
                .prepare(`SELECT * FROM local_runtime_thread_goals
           WHERE updated_at_ms >= ?
           ORDER BY updated_at_ms DESC, goal_id DESC
           LIMIT ?`)
                .all(input.sinceMs, MAX_DIAGNOSTIC_GOALS + 1);
            const truncated = rows.length > MAX_DIAGNOSTIC_GOALS;
            const goals = rows
                .slice(0, MAX_DIAGNOSTIC_GOALS)
                .map((row) => rowToThreadGoalState(row))
                .filter((goal) => goal !== undefined)
                .map((goal) => DEFAULT_OBSERVABILITY_REDACTION_POLICY.sanitizeFields({
                goalId: goal.goalId,
                sessionId: goal.sessionId,
                status: goal.status,
                statusReason: goal.statusReason,
                createdAtMs: goal.createdAt,
                updatedAtMs: goal.updatedAt,
                ...(goal.lastVerification
                    ? {
                        lastVerification: {
                            backend: goal.lastVerification.backend,
                            verdict: goal.lastVerification.verdict,
                            reason: goal.lastVerification.reason,
                            missing: [...goal.lastVerification.missing],
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
                            ...(goal.lastWorkerProposal.summary
                                ? { summary: goal.lastWorkerProposal.summary }
                                : {}),
                            atMs: goal.lastWorkerProposal.at,
                        },
                    }
                    : {}),
            }));
            if (goals.length === 0)
                return [];
            const content = Buffer.from(`${JSON.stringify({
                schemaVersion: 1,
                generatedAtMs: input.nowMs,
                objectiveIncluded: false,
                transcriptIncluded: false,
                truncated,
                goals,
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
        finally {
            db?.close();
        }
    }
}
function hasThreadGoalTable(db) {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('local_runtime_thread_goals');
    return row?.name === 'local_runtime_thread_goals';
}
//# sourceMappingURL=diagnostic-source.js.map