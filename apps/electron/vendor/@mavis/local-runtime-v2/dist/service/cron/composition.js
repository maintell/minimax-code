import { isSelfReminderId } from '@mavis/shared/cron-purpose';
import { SqliteCronDefinitionRepository } from './adapters/definition.repository.js';
import { createCronMetrics } from './adapters/metrics.client.js';
import { SqliteCronRunRepository } from './adapters/run.repository.js';
import { createCronService } from './orchestration/cron.service.js';
import { CronExecutor } from './orchestration/executor.js';
import { CronDataLifecycle } from './orchestration/lifecycle.js';
import { CRON_SCHEDULER_HANDLER_KEY, } from './contracts.js';
import { toCronSchedule } from './orchestration/schedule.js';
const NOOP_EXECUTION_LOGGER = {
    warn: () => undefined,
};
const CRON_EXECUTOR_UNAVAILABLE = 'CRON_EXECUTOR_UNAVAILABLE';
const SOURCE_QUALIFIED_MODEL_SELECTION = {
    resolve: (rawModel) => {
        const modelKey = rawModel.trim();
        const separator = modelKey.indexOf('/');
        return separator > 0 && separator < modelKey.length - 1
            ? { kind: 'resolved', modelKey }
            : { kind: 'not_found' };
    },
};
const FAIL_CLOSED_SESSION_CREATION = {
    create: () => Promise.reject(new Error('Cron session creation is not available on this runtime host')),
    discard: () => Promise.resolve(),
};
const FAIL_CLOSED_DELIVERY = {
    deliver: () => Promise.resolve({
        delivered: false,
        errorCode: CRON_EXECUTOR_UNAVAILABLE,
        error: 'Cron delivery is not available on this runtime host',
    }),
};
export function composeCronService(options) {
    const nowMs = options.nowMs ?? Date.now;
    const metrics = options.metrics ?? createCronMetrics();
    const definitions = new SqliteCronDefinitionRepository(options.db);
    const runs = new SqliteCronRunRepository(options.db);
    const lifecycle = new CronDataLifecycle({
        db: options.db,
        scheduler: options.scheduler,
        definitions,
        runs,
    });
    const executor = new CronExecutor({
        db: options.db,
        definitions,
        runs,
        lifecycle,
        sessionCreation: options.sessionPorts?.sessionCreation ?? FAIL_CLOSED_SESSION_CREATION,
        delivery: options.sessionPorts?.delivery ?? FAIL_CLOSED_DELIVERY,
        nowMs,
        logger: options.executionLogger ?? NOOP_EXECUTION_LOGGER,
        metrics,
    });
    const acceptScheduledTrigger = (schedulerId, job, metricTask) => {
        const accepted = executor.acceptScheduledTrigger({
            schedulerId,
            triggerId: `${schedulerId}:${job.scheduleGeneration}:${job.runCount}`,
            ...(metricTask ? { triggerMetric: { source: 'schedule', task: metricTask } } : {}),
        });
        if (!accepted.accepted && metricTask) {
            metrics.taskTriggered(metricTask, 'schedule', accepted.errorCode === 'CRON_PERSIST_FAILED' ? 'error' : 'skipped');
        }
        if (!accepted.accepted && accepted.errorCode === 'CRON_PERSIST_FAILED') {
            throw new Error('Cron scheduled trigger persistence failed');
        }
    };
    options.scheduler.registerHandler(CRON_SCHEDULER_HANDLER_KEY, async (schedulerId) => {
        const job = options.scheduler.get(schedulerId);
        if (!job)
            return;
        const metricTask = resolveScheduledMetricTask(definitions, job);
        const definition = definitions.getBySchedulerId(schedulerId);
        if (definition && (await executor.isTargetArchived(definition))) {
            if (metricTask)
                metrics.taskTriggered(metricTask, 'schedule', 'skipped');
            return;
        }
        acceptScheduledTrigger(schedulerId, job, metricTask);
    });
    const service = createCronService({
        reviewContent: options.reviewContent,
        lifecycle,
        scheduler: options.scheduler,
        definitions,
        runs,
        executor,
        sessionCreation: options.sessionPorts?.sessionCreation ?? FAIL_CLOSED_SESSION_CREATION,
        nowMs,
        metrics,
        modelSelection: options.modelSelection ?? SOURCE_QUALIFIED_MODEL_SELECTION,
    });
    return {
        service,
        executor,
        isSessionOwnedByDefinition: (sessionId) => hasActiveDefinitionOwningSession(definitions, sessionId),
        recoverPendingRuns: async () => {
            await executor.recoverPendingRuns();
        },
        close: async () => {
            // Stop definition mutations and queue scheduling before waiting. Session-side
            // reconciliation must drain while its downstream Session owner is alive.
            const results = await Promise.allSettled([service.close(), executor.close()]);
            const failure = results.find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected')
                throw failure.reason;
        },
    };
}
function hasActiveDefinitionOwningSession(definitions, sessionId) {
    let before;
    do {
        const page = definitions.listPage({
            take: 200,
            ...(before ? { before } : {}),
        });
        if (page.some((definition) => !isSelfReminderId(definition.cronId) &&
            definition.sessionTarget.mode === 'sessionId' &&
            definition.sessionTarget.sessionId === sessionId)) {
            return true;
        }
        const last = page.at(-1);
        before =
            page.length === 200 && last
                ? { createdAtMs: last.createdAtMs, cronId: last.cronId }
                : undefined;
    } while (before);
    return false;
}
function resolveScheduledMetricTask(definitions, job) {
    try {
        const definition = definitions.getBySchedulerId(job.schedulerId);
        if (!definition)
            return undefined;
        return {
            agentName: definition.agentName,
            schedule: toCronSchedule(job.schedule),
            sessionTarget: definition.sessionTarget,
        };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=composition.js.map