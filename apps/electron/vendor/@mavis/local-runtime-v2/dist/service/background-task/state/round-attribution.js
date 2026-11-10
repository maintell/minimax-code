import { logger } from '@mavis/shared/local-runtime-logging/logger';
/**
 * Reports which parent Turn asked for the child round a task row stands for.
 * Any row kind carrying `parentSessionId`, `parentTurnId` and `subTurnId` is
 * reported with its kind (bash rows have no `subTurnId`); the bound owner
 * decides which kinds count. Every writer (foreground, background, task_append activation)
 * creates the row before the child round is submitted or delivered, so running
 * this from the row's creation is what makes the pairing precede the round's
 * first model request. Never throws: attribution must not fail task creation.
 */
export async function attributeTaskRowRound(port, task) {
    if (!port)
        return;
    const metadata = task.metadata ?? {};
    const parentSessionId = nonEmptyString(metadata.parentSessionId);
    const parentTurnId = nonEmptyString(metadata.parentTurnId);
    const childTurnId = nonEmptyString(metadata.subTurnId);
    if (!parentSessionId || !parentTurnId || !childTurnId)
        return;
    const childSessionId = nonEmptyString(metadata.childSessionId);
    try {
        await port.attributeRound({
            parentSessionId,
            parentTurnId,
            ...(childSessionId ? { childSessionId } : {}),
            childTurnId,
            kind: task.kind,
        });
    }
    catch (error) {
        logger.warn({
            taskId: task.taskId,
            parentSessionId,
            parentTurnId,
            childTurnId,
            error: error instanceof Error ? error.message : String(error),
        }, 'Sub-session round attribution failed for a task row');
    }
}
function nonEmptyString(value) {
    return typeof value === 'string' && value ? value : undefined;
}
//# sourceMappingURL=round-attribution.js.map