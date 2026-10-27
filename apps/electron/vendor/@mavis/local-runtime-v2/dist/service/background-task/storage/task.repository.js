import { and, eq, inArray, gte, lte, isNull } from 'drizzle-orm';
import { backgroundTasks as table } from '../../../infra/db/schema/background-tasks.js';
import { TaskAlreadyExistsError, TaskNotFoundError, InvalidTaskStatusTransitionError, canTransitionTaskStatus, isTerminalTaskStatus, } from '@mavis/background-task/local';
import { matchesQuery, getOrderValue } from './task-query.js';
/** State transitions and visibility are committed against the same row. */
export class BackgroundTaskRepository {
    db;
    nowMs;
    constructor(db, nowMs = Date.now) {
        this.db = db;
        this.nowMs = nowMs;
    }
    async create(task) {
        return this.db.transaction((tx) => {
            if (tx.select().from(table).where(eq(table.taskId, task.taskId)).get())
                throw new TaskAlreadyExistsError(task.taskId);
            const created = { ...task, isDeleted: false };
            tx.insert(table).values(values(created)).run();
            return created;
        }, { behavior: 'immediate' });
    }
    async get(taskId) {
        return this.getRow(taskId);
    }
    getRow(taskId) {
        const row = this.db.select().from(table).where(eq(table.taskId, taskId)).get();
        return row ? decode(row) : undefined;
    }
    matching(query) {
        return this.db
            .select()
            .from(table)
            .where(and(query.ownerSessionId ? eq(table.ownerSessionId, query.ownerSessionId) : undefined, query.taskIds ? inArray(table.taskId, query.taskIds) : undefined, query.statuses ? inArray(table.status, query.statuses) : undefined, query.kinds ? inArray(table.kind, query.kinds) : undefined, query.createdAfter !== undefined ? gte(table.createdAtMs, query.createdAfter) : undefined, query.createdBefore !== undefined
            ? lte(table.createdAtMs, query.createdBefore)
            : undefined, query.updatedAfter !== undefined ? gte(table.updatedAtMs, query.updatedAfter) : undefined, query.updatedBefore !== undefined
            ? lte(table.updatedAtMs, query.updatedBefore)
            : undefined, query.undeliveredOnly ? isNull(table.deliveredAtMs) : undefined))
            .all()
            .map(decode)
            .filter((task) => matchesQuery(task, query));
    }
    async list(query) {
        const orderBy = query.orderBy ?? 'created_at';
        const tasks = this.matching(query).sort((a, b) => (getOrderValue(a, orderBy) - getOrderValue(b, orderBy)) * (query.order === 'asc' ? 1 : -1));
        const offset = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
        const limit = query.limit && query.limit > 0 ? Math.min(Math.floor(query.limit), 500) : 100;
        const items = tasks.slice(offset, offset + limit);
        return {
            items,
            ...(offset + items.length < tasks.length
                ? { nextCursor: String(offset + items.length) }
                : {}),
        };
    }
    async listForApp(ownerSessionId) {
        return this.db
            .select()
            .from(table)
            .where(and(eq(table.ownerSessionId, ownerSessionId), eq(table.kind, 'bash'), eq(table.isDeleted, false)))
            .all()
            .map(decode)
            .filter((task) => task.metadata?.executionMode !== 'managed_foreground')
            .sort((a, b) => b.createdAt - a.createdAt || a.taskId.localeCompare(b.taskId));
    }
    async snapshotPending() {
        return this.matching({ statuses: ['queued', 'running', 'stopping'] });
    }
    async reminderSnapshot(ownerSessionId, limit = 5) {
        const terminal = this.matching({
            ownerSessionId,
            statuses: ['succeeded', 'failed', 'canceled', 'lost'],
        });
        const unread = terminal
            .filter((task) => task.deliveredAt === undefined)
            .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0) || a.taskId.localeCompare(b.taskId));
        return {
            tasks: unread.slice(0, Math.max(0, Math.floor(limit))),
            undeliveredTotal: unread.length,
            terminalTotal: terminal.length,
        };
    }
    async patch(taskId, patch) {
        return this.db.transaction(() => {
            const current = this.getRow(taskId);
            if (!current)
                throw new TaskNotFoundError(taskId);
            if (patch.status && !canTransitionTaskStatus(current.status, patch.status))
                throw new InvalidTaskStatusTransitionError(taskId, current.status, patch.status);
            const updated = {
                ...current,
                ...patch,
                isDeleted: current.isDeleted,
                metadata: { ...current.metadata, ...patch.metadata },
                updatedAt: patch.updatedAt ?? this.nowMs(),
            };
            this.db.update(table).set(values(updated)).where(eq(table.taskId, taskId)).run();
            return updated;
        }, { behavior: 'immediate' });
    }
    async softDelete(taskId) {
        return this.db.transaction(() => {
            const current = this.getRow(taskId);
            if (!current)
                throw new TaskNotFoundError(taskId);
            if (!isTerminalTaskStatus(current.status))
                throw new Error('A running background task cannot be deleted');
            if (current.isDeleted)
                return current;
            const updatedAt = this.nowMs();
            this.db
                .update(table)
                .set({ isDeleted: true, updatedAtMs: updatedAt })
                .where(eq(table.taskId, taskId))
                .run();
            return { ...current, isDeleted: true, updatedAt };
        }, { behavior: 'immediate' });
    }
    async updateStatus(taskId, status, reason) {
        return this.patch(taskId, {
            status,
            ...(reason && ['failed', 'canceled', 'lost'].includes(status)
                ? { lastError: { message: reason, code: status.toUpperCase() } }
                : {}),
        });
    }
}
function values(task) {
    return {
        taskId: task.taskId,
        ownerSessionId: task.ownerSessionId,
        kind: task.kind,
        status: task.status,
        createdAtMs: task.createdAt,
        updatedAtMs: task.updatedAt,
        endedAtMs: task.endedAt ?? null,
        deliveredAtMs: task.deliveredAt ?? null,
        recordJson: JSON.stringify(task),
        isDeleted: task.isDeleted ?? false,
    };
}
function decode(row) {
    return {
        ...JSON.parse(row.recordJson),
        isDeleted: row.isDeleted,
        updatedAt: row.updatedAtMs,
    };
}
//# sourceMappingURL=task.repository.js.map