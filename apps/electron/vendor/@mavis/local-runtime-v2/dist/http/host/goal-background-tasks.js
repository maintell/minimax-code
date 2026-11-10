/** Rows of one task-store page (the store's cap) and pages one read may take. */
const BACKGROUND_TASK_PAGE_SIZE = 500;
const BACKGROUND_TASK_MAX_PAGES = 200;
/** Every row matching `query`; offset pages can repeat a row, so rows are keyed by task id. */
export async function listAllV1BackgroundTasks(tasks, query) {
    const rows = new Map();
    let cursor;
    for (let page = 0; page < BACKGROUND_TASK_MAX_PAGES; page += 1) {
        const result = await tasks.list({
            ...query,
            limit: BACKGROUND_TASK_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
        });
        for (const task of result.items)
            if (!rows.has(task.taskId))
                rows.set(task.taskId, task);
        cursor = result.nextCursor;
        if (!cursor)
            break;
    }
    return [...rows.values()];
}
//# sourceMappingURL=goal-background-tasks.js.map