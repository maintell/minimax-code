import { currentHeapUsageBucket } from '../../../infra/observability/heap-usage-metrics.js';
/** Compose product participants without weakening any participant's rollback contract. */
export function composeTurnSubmissionPreparations(...candidates) {
    const preparations = candidates.filter((candidate) => candidate !== undefined);
    if (preparations.length === 0)
        return undefined;
    return {
        async prepare(input) {
            const ready = [];
            try {
                for (const preparation of preparations) {
                    const result = await preparation.prepare(input);
                    if (!result)
                        continue;
                    if (result.status === 'rejected') {
                        await restoreAll(ready, 'rollback');
                        return result;
                    }
                    ready.push(result);
                }
            }
            catch (error) {
                await restoreAll(ready, 'rollback', error);
                throw error;
            }
            if (ready.length === 0)
                return undefined;
            let attemptedCommits = 0;
            return {
                status: 'ready',
                ...(ready.some((preparation) => preparation.beforeHost)
                    ? {
                        beforeHost: async (signal) => {
                            for (const preparation of ready) {
                                signal.throwIfAborted();
                                await preparation.beforeHost?.(signal);
                            }
                        },
                    }
                    : {}),
                commit: async () => {
                    for (const preparation of ready) {
                        attemptedCommits += 1;
                        await preparation.commit();
                    }
                },
                rollback: () => restoreAll(ready, 'rollback'),
                compensate: async () => {
                    const errors = [];
                    for (let index = ready.length - 1; index >= 0; index -= 1) {
                        try {
                            if (index < attemptedCommits)
                                await ready[index]?.compensate();
                            else
                                await ready[index]?.rollback();
                        }
                        catch (error) {
                            errors.push(error);
                        }
                    }
                    if (errors.length > 0) {
                        throw new AggregateError(errors, 'Submission preparation compensation failed');
                    }
                },
            };
        },
    };
}
/** Sources the memory pressure design treats as automatic work; every other source is the user's. */
const AUTOMATIC_SUBMISSION_SOURCES = new Set([
    'task',
    'background-task',
    'thread-goal',
    'cron',
    'communication',
    'greeting',
    'team',
]);
/**
 * Counts every admitted submission by origin and JS heap use, without changing admission. The
 * counts show how much automatic work starts while the heap is already high.
 */
export function createSubmissionMemoryMetricsPreparation(metrics) {
    if (!metrics)
        return undefined;
    return {
        prepare: async (candidate) => {
            try {
                metrics.counter('turn_submission_total', 1, {
                    origin: submissionOrigin(candidate),
                    usage_bucket: currentHeapUsageBucket(),
                    mode: 'off',
                    platform: process.platform,
                });
            }
            catch {
                // Observation only; admission never depends on the metrics sink.
            }
            return undefined;
        },
    };
}
function submissionOrigin(candidate) {
    if (candidate.genuineUserQueryText || candidate.userInputResume)
        return 'user';
    return AUTOMATIC_SUBMISSION_SOURCES.has(candidate.provenance.source) ? 'auto' : 'user';
}
/** Adapts the Goal admission participant to the shared Turn preparation contract. */
export function createGoalTurnSubmissionPreparation(input) {
    const prepare = input.prepare;
    if (!prepare)
        return undefined;
    return {
        prepare: (candidate) => prepare({
            ...candidate,
            hasPendingPlan: input.hasPendingPlan,
            hasPriorityMailboxWork: input.hasPriorityMailboxWork,
        }),
    };
}
async function restoreAll(ready, method, primaryError) {
    const errors = [];
    for (let index = ready.length - 1; index >= 0; index -= 1) {
        try {
            await ready[index]?.[method]();
        }
        catch (error) {
            errors.push(error);
        }
    }
    if (errors.length === 0)
        return;
    throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], `Submission preparation ${method} failed`);
}
//# sourceMappingURL=submission-preparation.js.map