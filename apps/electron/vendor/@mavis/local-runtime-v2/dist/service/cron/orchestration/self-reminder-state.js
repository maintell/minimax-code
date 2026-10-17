import { isSelfReminderId } from '@mavis/shared/cron-purpose';
/** 只用持久化事实判定名额，调用方在写事务内完成检查与变更。 */
export function unfinishedSelfReminders(sessionId, deps) {
    return [...sessionSelfReminders(sessionId, deps.definitions)].filter((definition) => occupiesReminderSlot(definition, deps));
}
/** 软删记录仍参与 timer 清理，允许取消提交后的清理失败重试。 */
export function selfRemindersToCancel(sessionId, deps) {
    return [...sessionSelfReminders(sessionId, deps.definitions, true)].filter((definition) => definition.deletedAtMs !== undefined || occupiesReminderSlot(definition, deps));
}
function* sessionSelfReminders(sessionId, definitions, includeDeleted = false) {
    let before;
    do {
        const page = definitions.listPage({ sessionId, includeDeleted, before, take: 100 });
        for (const definition of page) {
            if (isSelfReminderId(definition.cronId))
                yield definition;
        }
        const last = page.at(-1);
        before =
            page.length === 100 && last
                ? { createdAtMs: last.createdAtMs, cronId: last.cronId }
                : undefined;
    } while (before);
}
function occupiesReminderSlot(definition, deps) {
    if (deps.runs.hasPendingForCronId(definition.cronId))
        return true;
    const job = deps.scheduler.inspect(definition.schedulerId);
    if (!job || job.state === 'active' || job.state === 'cancelled')
        return true;
    if (job.state === 'expired')
        return false;
    // Scheduler 先完成 trigger，再接纳 Cron Run；缺少本代次 Run 时继续占用。
    const run = deps.runs.getBySchedulerTriggerId(`${job.schedulerId}:${job.scheduleGeneration}:${job.runCount}`);
    return !run || run.cronId !== definition.cronId || run.status === 'pending';
}
//# sourceMappingURL=self-reminder-state.js.map