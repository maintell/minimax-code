import { decodeCronModel } from '@mavis/shared/cron-model';
import { isSelfReminderId } from '@mavis/shared/cron-purpose';
import { CRON_SCHEDULER_HANDLER_KEY, } from '../contracts.js';
import { CRON_DEFINITION_DELETED, CRON_DEFINITION_DELETED_ERROR, CRON_DEFINITION_PAUSED, CRON_DEFINITION_PAUSED_ERROR, CronRepositoryError, } from '../errors.js';
import { toCronSchedule, toSchedulerSchedule } from './schedule.js';
import { finishedSelfReminders, selfRemindersToCancel, unfinishedSelfReminders, } from './self-reminder-state.js';
export class CronDataLifecycle {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    targetsMainConversation(agentName) {
        return this.dependencies.mainConversationAgents?.(agentName) === true;
    }
    create(request) {
        const input = this.targetsMainConversation(request.agentName) && !isSelfReminderId(request.cronId)
            ? { ...request, sessionTarget: { mode: 'sessionId' } }
            : request;
        let schedulerId;
        try {
            return this.immediate(() => {
                if (isSelfReminderId(input.cronId)) {
                    const existing = this.dependencies.definitions.get(input.cronId, true);
                    if (existing)
                        return existing;
                    this.assertReminderAvailable(input.cronId, input.sessionTarget);
                }
                schedulerId = this.dependencies.scheduler.schedule(CRON_SCHEDULER_HANDLER_KEY, toSchedulerSchedule(input.schedule));
                if (input.active === false)
                    this.dependencies.scheduler.cancel(schedulerId);
                return this.dependencies.definitions.insert({
                    ...(input.cronId ? { cronId: input.cronId } : {}),
                    schedulerId,
                    agentName: input.agentName,
                    name: input.name,
                    prompt: input.prompt,
                    sessionTarget: input.sessionTarget,
                    ...(input.project === undefined ? {} : { project: input.project }),
                    ...(input.model === undefined ? {} : { model: input.model }),
                    createdAtMs: input.nowMs,
                });
            });
        }
        catch (error) {
            if (schedulerId)
                this.discardSchedulerJob(schedulerId);
            throw error;
        }
    }
    get(cronId, includeDeleted = false) {
        return this.dependencies.definitions.get(cronId, includeDeleted);
    }
    update(input) {
        return this.immediate(() => {
            const definition = requireDefinition(this.dependencies.definitions.get(input.cronId));
            const job = requireSchedulerJob(this.dependencies.scheduler.get(definition.schedulerId));
            const update = this.prepareReminderUpdate(definition, input);
            if (mayOccupyReminderSlot(job, update)) {
                this.assertReminderAvailable(definition.cronId, definition.sessionTarget);
            }
            if (update.project !== undefined) {
                if (this.dependencies.runs.listPage({ cronId: update.cronId, take: 1 }).length > 0) {
                    throw new CronRepositoryError('CRON_INVALID_STATE', 'Cron project can only change before its first run');
                }
            }
            const hasDefinitionPatch = update.name !== undefined ||
                update.prompt !== undefined ||
                update.sessionTarget !== undefined ||
                update.model !== undefined ||
                update.project !== undefined;
            const updatedDefinition = hasDefinitionPatch
                ? this.dependencies.definitions.update(update.cronId, definition.revision, definitionPatch(update), update.nowMs)
                : definition;
            this.updateSchedulerJob(job, update);
            return updatedDefinition;
        });
    }
    delete(input) {
        this.immediate(() => {
            const definition = requireDefinition(this.dependencies.definitions.get(input.cronId));
            requireSchedulerJob(this.dependencies.scheduler.get(definition.schedulerId));
            if (input.deleteRuns ?? true) {
                if (this.dependencies.runs.hasPendingForCronId(input.cronId)) {
                    throw new CronRepositoryError('CRON_INVALID_STATE', 'Cron definition has pending runs');
                }
                this.dependencies.runs.deleteByCronId(input.cronId);
                if (!this.dependencies.definitions.hardDelete(input.cronId)) {
                    throw new Error('Cron definition delete failed');
                }
                if (!this.dependencies.scheduler.remove(definition.schedulerId)) {
                    throw new Error('Scheduler job delete failed');
                }
                return;
            }
            this.dependencies.definitions.tombstone(input.cronId, definition.revision, input.nowMs);
            this.failPendingRuns(input.cronId, input.nowMs);
            this.dependencies.scheduler.cancel(definition.schedulerId);
        });
    }
    cancelSelfReminders(sessionId, nowMs) {
        const cancelled = this.immediate(() => {
            const definitions = selfRemindersToCancel(sessionId, this.dependencies);
            for (const definition of definitions) {
                if (definition.deletedAtMs === undefined) {
                    this.dependencies.definitions.tombstone(definition.cronId, definition.revision, nowMs);
                }
                this.failPendingRuns(definition.cronId, nowMs);
            }
            return definitions;
        });
        // 软删除是取消的持久化事实。提交后清理 timer，避免事务回滚与内存计时器分叉。
        // 缺失或另一 owner 的 job 不妨碍取消；执行准入和投递仍会检查软删除。
        const errors = [];
        for (const definition of cancelled) {
            try {
                this.dependencies.scheduler.cancel(definition.schedulerId);
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length > 0)
            throw errors[0];
        return cancelled
            .filter((definition) => definition.deletedAtMs === undefined)
            .map((definition) => definition.cronId);
    }
    /**
     * 已结束的自提醒转为软删：任务列表不再展示，运行历史保留；
     * 同一 tool call 重试仍读到原记录，不会复活。不传 sessionId 时清扫全部会话。
     */
    retireFinishedSelfReminders(nowMs, sessionId) {
        return this.immediate(() => {
            const finished = finishedSelfReminders(this.dependencies, sessionId);
            for (const definition of finished) {
                this.dependencies.definitions.tombstone(definition.cronId, definition.revision, nowMs);
            }
            return finished.map((definition) => definition.cronId);
        });
    }
    createManualRun(cronId, nowMs, requestId) {
        return this.immediate(() => {
            const definition = requireDefinition(this.dependencies.definitions.get(cronId));
            this.assertReminderAvailable(cronId, definition.sessionTarget);
            return this.dependencies.runs.insertPendingManualForDefinition(cronId, nowMs, requestId);
        });
    }
    /**
     * 撤回定义时一并结掉它还欠着的投递（排队中或等待重试）。否则这些 Run 会在之后
     * 会话空闲时被接纳成 turn，再在接纳阶段被否决，把会话写成 error。
     * 正在进行首次投递的 Run 保留并允许完成，仍由 beforeDelivery 兜底。
     */
    failPendingRuns(cronId, nowMs, reason = {
        errorCode: CRON_DEFINITION_DELETED,
        error: CRON_DEFINITION_DELETED_ERROR,
    }) {
        this.dependencies.runs.failPendingForCronId({
            cronId,
            failedAtMs: nowMs,
            errorCode: reason.errorCode,
            error: reason.error,
        });
    }
    assertReminderAvailable(cronId, target) {
        if (!isSelfReminderId(cronId))
            return;
        if (target.mode !== 'sessionId' || !target.sessionId) {
            throw new CronRepositoryError('CRON_INVALID_STATE', 'A self reminder requires a fixed session.');
        }
        if (unfinishedSelfReminders(target.sessionId, this.dependencies).some((item) => item.cronId !== cronId)) {
            throw new CronRepositoryError('SELF_REMINDER_EXISTS', 'This session already has an unfinished self reminder. Cancel it before setting another.');
        }
    }
    prepareReminderUpdate(definition, input) {
        if (!isSelfReminderId(definition.cronId))
            return normalizeScheduleUpdate(input, this.targetsMainConversation(definition.agentName));
        const { sessionTarget, model, project, ...mutable } = input;
        if ((sessionTarget !== undefined &&
            !sameReminderTarget(sessionTarget, definition.sessionTarget)) ||
            (model !== undefined && !sameReminderModel(model, definition.model)) ||
            (project !== undefined && (project ?? null) !== (definition.project ?? null))) {
            throw new CronRepositoryError('CRON_INVALID_STATE', 'A self reminder keeps its original session, model and workspace.');
        }
        // 编辑表单可回传固定字段；校验后保留原存储表示和默认参数策略。
        return mutable;
    }
    updateSchedulerJob(job, input) {
        if (input.schedule === undefined && input.active === undefined)
            return;
        const schedule = input.schedule ?? toCronSchedule(job.schedule);
        const shouldBeActive = input.active ?? job.state === 'active';
        if (input.schedule !== undefined || (shouldBeActive && job.state !== 'active')) {
            this.dependencies.scheduler.reschedule(job.schedulerId, toSchedulerSchedule(schedule));
        }
        if (!shouldBeActive) {
            // 暂停必须立刻生效：先结清排队中和退避重试中的 Run，再停 timer。否则这些 Run
            // 会在之后会话空闲时被接纳成 turn，暂停看起来停不下来。软删路径（delete）自己
            // 已经结清过，这里不重复调用。
            // The definition still exists — it was paused, not deleted — so run history must
            // say so rather than telling the user their task was deleted.
            this.failPendingRuns(input.cronId, input.nowMs, {
                errorCode: CRON_DEFINITION_PAUSED,
                error: CRON_DEFINITION_PAUSED_ERROR,
            });
            this.dependencies.scheduler.cancel(job.schedulerId);
        }
    }
    discardSchedulerJob(schedulerId) {
        try {
            this.dependencies.scheduler.remove(schedulerId);
        }
        catch {
            // 保留最初的创建失败。
        }
    }
    immediate(operation) {
        return this.dependencies.db.transaction(operation, { behavior: 'immediate' });
    }
}
function normalizeScheduleUpdate(input, targetsMainConversation) {
    return targetsMainConversation ? { ...input, sessionTarget: { mode: 'sessionId' } } : input;
}
function mayOccupyReminderSlot(job, update) {
    return (update.schedule !== undefined ||
        update.active === true ||
        (update.active === false && job.state !== 'active' && job.state !== 'cancelled'));
}
function definitionPatch(input) {
    return {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.sessionTarget === undefined ? {} : { sessionTarget: input.sessionTarget }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.project === undefined ? {} : { project: input.project }),
    };
}
function requireDefinition(definition) {
    if (!definition) {
        throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition not found');
    }
    return definition;
}
function requireSchedulerJob(job) {
    if (!job) {
        throw new CronRepositoryError('CRON_NOT_FOUND', 'Cron definition has no Scheduler job');
    }
    return job;
}
function sameReminderTarget(left, right) {
    if (left.mode === 'new')
        return right.mode === 'new';
    return right.mode === 'sessionId' && left.sessionId === right.sessionId;
}
function sameReminderModel(left, right) {
    if (left == null || right == null)
        return (left ?? null) === (right ?? null);
    const before = decodeCronModel(right);
    const after = decodeCronModel(left);
    return (before.modelKey === after.modelKey &&
        before.selection?.variant === after.selection?.variant &&
        before.selection?.thinking?.effort === after.selection?.thinking?.effort &&
        before.selection?.contextLimit === after.selection?.contextLimit);
}
//# sourceMappingURL=lifecycle.js.map