import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { memoryExecutionCalls as calls, memoryExecutionTasks as tasks, } from '../../../infra/db/schema/memory-executions.js';
import { createMemoryExecutionQuery } from './query.js';
/** 元数据写失败必须显式传出，领域层的模型错误分类不能掩盖账本故障。 */
class MemoryExecutionWriteError extends Error {
    constructor() {
        super('memory-execution-write-failed');
    }
}
export class MemoryExecutionLedger {
    db;
    nowMs;
    context = new AsyncLocalStorage();
    query;
    constructor(db, nowMs = Date.now) {
        this.db = db;
        this.nowMs = nowMs;
        this.query = createMemoryExecutionQuery(db);
    }
    write(action) {
        const task = this.context.getStore()?.task;
        if (task?.writeFailed)
            throw new MemoryExecutionWriteError();
        try {
            return action();
        }
        catch {
            if (task)
                task.writeFailed = true;
            throw new MemoryExecutionWriteError();
        }
    }
    async run(input, action) {
        const taskId = randomUUID();
        this.write(() => this.db
            .insert(tasks)
            .values({ ...input, taskId, startedAtMs: this.nowMs(), status: 'started' })
            .run());
        const task = { taskId, ordinal: 0, writeFailed: false };
        return this.context.run({ task, sourceRef: input.sourceRef }, async () => {
            let result;
            try {
                result = await action();
            }
            catch (error) {
                this.write(() => this.db
                    .update(tasks)
                    .set({ status: 'failed', reason: 'execution-threw', finishedAtMs: this.nowMs() })
                    .where(eq(tasks.taskId, taskId))
                    .run());
                throw error;
            }
            this.write(() => this.db
                .update(tasks)
                .set({
                status: result.status,
                reason: result.reason ?? null,
                previewId: result.previewId ?? input.previewId ?? null,
                finishedAtMs: this.nowMs(),
            })
                .where(eq(tasks.taskId, taskId))
                .run());
            return result;
        });
    }
    withSource(sourceRef, action) {
        const context = this.context.getStore();
        if (!context)
            throw new Error('memory-execution-context-missing');
        return this.context.run({ ...context, sourceRef }, action);
    }
    modelCalls = {
        started: (input) => {
            const context = this.context.getStore();
            if (!context)
                throw new Error('memory-execution-context-missing');
            const callId = randomUUID();
            this.write(() => this.db
                .insert(calls)
                .values({
                callId,
                taskId: context.task.taskId,
                ordinal: ++context.task.ordinal,
                sourceRef: context.sourceRef,
                ...input,
            })
                .run());
            return callId;
        },
        finished: (callId, result) => {
            this.write(() => this.db
                .update(calls)
                .set({
                finishedAtMs: result.finishedAtMs,
                stopReason: result.stopReason,
                inputTokens: result.usage?.input ?? null,
                outputTokens: result.usage?.output ?? null,
                cacheReadTokens: result.usage?.cacheRead ?? null,
                cacheWriteTokens: result.usage?.cacheWrite ?? null,
                totalTokens: result.usage?.totalTokens ?? null,
            })
                .where(eq(calls.callId, callId))
                .run());
        },
    };
}
//# sourceMappingURL=ledger.js.map