import { isTerminalTaskStatus, } from './domain.js';
import { logger } from '../common/logger.js';
/** 只跟踪启动快照中尚未决的外部 owner；无变化轮询不重复全量读取。 */
export class StartupTaskRecovery {
    watchedTasks = new Map();
    options = {};
    settlement;
    constructor(settlement) {
        this.settlement = settlement;
    }
    hasPending() {
        return this.watchedTasks.size > 0;
    }
    async collect(store, options, owner) {
        const pending = await store.snapshotPending();
        this.options = options;
        this.watchedTasks.clear();
        return this.select(pending, owner);
    }
    async poll(store, owner) {
        const refreshOwners = new Set();
        for (const [ownerId, taskIds] of this.watchedTasks) {
            if (owner.isOwnerAlive(ownerId) === false) {
                refreshOwners.add(ownerId);
                continue;
            }
            let pending = false;
            for (const taskId of taskIds) {
                const task = await store.get(taskId);
                if (task &&
                    !isTerminalTaskStatus(task.status) &&
                    task.metadata?.runtimeOwnerId === ownerId) {
                    pending = true;
                }
                else {
                    taskIds.delete(taskId);
                }
            }
            if (!pending)
                refreshOwners.add(ownerId);
        }
        if (refreshOwners.size === 0)
            return [];
        // owner 退出或已知任务全结算才刷新，覆盖首次快照后该 owner 新建的任务。
        const pending = await store.snapshotPending();
        for (const ownerId of refreshOwners)
            this.watchedTasks.delete(ownerId);
        return this.select(pending.filter((task) => {
            const ownerId = task.metadata?.runtimeOwnerId;
            return typeof ownerId === 'string' && refreshOwners.has(ownerId);
        }), owner);
    }
    async settle(pending, options = {}) {
        const reason = options.reason ?? 'Local runtime restarted before task completed';
        const lost = [];
        for (const task of pending) {
            const now = this.settlement.nowMs();
            const patched = await this.settlement.patchLost(task, {
                updatedAt: now,
                endedAt: now,
                lastError: { message: reason, code: 'TASK_LOST_ON_STARTUP' },
            });
            this.settled([patched.task]);
            if (!patched.patched)
                continue;
            const next = patched.task;
            logStartupLostTask(task, options.createdBeforeMs, now);
            this.settlement.onStatusChanged(next);
            lost.push(next);
        }
        return lost;
    }
    settled(tasks) {
        for (const task of tasks) {
            const ownerId = task.metadata?.runtimeOwnerId;
            if (typeof ownerId !== 'string')
                continue;
            const ids = this.watchedTasks.get(ownerId);
            ids?.delete(task.taskId);
            if (ids?.size === 0)
                this.watchedTasks.delete(ownerId);
        }
    }
    select(pending, owner) {
        const recoveredTurns = new Set(this.options.recoveredTurnIds ?? []);
        return pending.filter((task) => {
            if (this.options.createdBeforeMs !== undefined &&
                task.createdAt >= this.options.createdBeforeMs)
                return false;
            const ownerId = task.metadata?.runtimeOwnerId;
            if (owner && typeof ownerId === 'string' && ownerId !== owner.ownerId) {
                const ids = this.watchedTasks.get(ownerId) ?? new Set();
                ids.add(task.taskId);
                this.watchedTasks.set(ownerId, ids);
            }
            return !owner || isLostRuntimeTask(task, owner, recoveredTurns);
        });
    }
}
function isLostRuntimeTask(task, runtimeOwner, recoveredTurns) {
    const ownerId = task.metadata?.runtimeOwnerId;
    if (typeof ownerId === 'string')
        return runtimeOwner.isOwnerAlive(ownerId) === false;
    // Legacy rows have no owner identity. Only exact recovered Turn evidence
    // permits settlement; age or an idle Session does not prove ownership loss.
    const turnId = task.kind === 'subagent' ? task.metadata?.subTurnId : task.metadata?.turnId;
    if (typeof turnId === 'string' && recoveredTurns.has(turnId))
        return true;
    const parentTurnId = task.metadata?.parentTurnId;
    return (!task.metadata?.childSessionId &&
        typeof parentTurnId === 'string' &&
        recoveredTurns.has(parentTurnId));
}
function logStartupLostTask(task, createdBeforeMs, reconciledAt) {
    logger.warn({
        event: 'background_task_reconciled_lost_on_startup',
        taskId: task.taskId,
        ownerSessionId: task.ownerSessionId,
        kind: task.kind,
        priorStatus: task.status,
        taskCreatedAt: task.createdAt,
        taskUpdatedAt: task.updatedAt,
        startupCutoffMs: createdBeforeMs ?? null,
        reconciledAt,
        reasonCode: 'TASK_LOST_ON_STARTUP',
        processPid: process.pid,
        processParentPid: process.ppid,
        processExecPath: process.execPath,
    }, 'Local background task reconciled as lost at startup');
}
//# sourceMappingURL=startup-recovery.js.map