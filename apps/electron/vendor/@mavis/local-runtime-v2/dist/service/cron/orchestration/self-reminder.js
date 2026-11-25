import { createHash } from 'node:crypto';
import { formatSelfReminderName } from '@mavis/shared/cron-purpose';
import { CronRepositoryError } from '../errors.js';
import { assertCronContentSafe } from './content-safety.js';
/**
 * The fixed reporting line every self reminder's prompt ends with.
 *
 * Exported because the high-risk-write Skills teach the model to tell a
 * reminder it set itself from a scheduled task the user asked for by exactly
 * this ending. Exporting it lets the test that pins those Skills read the source
 * sentence instead of repeating it, so editing one side fails the build.
 *
 * @internal Exported only for that focused test; production reads it here.
 */
export const SELF_REMINDER_REPORTING_LINE = 'Only report meaningful progress, completion, failure or required user action.';
export function createSelfReminderService(deps) {
    const result = (definition) => ({
        reminder_id: definition.cronId,
        task: { cronId: definition.cronId, cronName: definition.name, prompt: definition.prompt },
        active: definition.deletedAtMs === undefined &&
            deps.scheduler.inspect(definition.schedulerId)?.state === 'active',
    });
    return {
        async set(command) {
            validateCommand(command);
            const cronId = `self-${createHash('sha256')
                .update(JSON.stringify([command.sessionId, command.turnId, command.toolCallId]))
                .digest('hex')
                .slice(0, 32)}`;
            const existing = deps.lifecycle.get(cronId, true);
            if (existing)
                return result(existing);
            const nowMs = deps.nowMs();
            const runAtMs = nowMs + command.delaySeconds * 1000;
            if (!Number.isSafeInteger(runAtMs) || runAtMs > 8_640_000_000_000_000) {
                throw new CronRepositoryError('CRON_INVALID_STATE', 'delay_seconds is outside the supported date range.');
            }
            await assertCronContentSafe(deps.reviewContent, command);
            // 审核期间同一 tool call 的重试可能已写入，保持 reminder 的幂等语义。
            const reviewedExisting = deps.lifecycle.get(cronId, true);
            if (reviewedExisting)
                return result(reviewedExisting);
            const definition = deps.lifecycle.create({
                cronId,
                agentName: command.agentName,
                name: formatSelfReminderName(cronId),
                prompt: `${command.prompt.trim()}\n\n${SELF_REMINDER_REPORTING_LINE}`,
                schedule: { kind: 'once', runAtMs },
                sessionTarget: { mode: 'sessionId', sessionId: command.sessionId },
                project: command.project,
                model: deps.resolveModel(command.model),
                nowMs,
            });
            return result(definition);
        },
        async cancel(sessionId) {
            if (!sessionId.trim()) {
                throw new CronRepositoryError('CRON_INVALID_STATE', 'The current session is required.');
            }
            const reminderIds = deps.lifecycle.cancelSelfReminders(sessionId, deps.nowMs());
            return { cancelled: true, reminder_ids: reminderIds };
        },
    };
}
function validateCommand(command) {
    for (const value of [
        command.sessionId,
        command.turnId,
        command.toolCallId,
        command.agentName,
        command.prompt,
    ]) {
        if (!value?.trim()) {
            throw new CronRepositoryError('CRON_INVALID_STATE', 'Complete reminder provenance and a prompt are required.');
        }
    }
    if (!Number.isSafeInteger(command.delaySeconds) || command.delaySeconds <= 0) {
        throw new CronRepositoryError('CRON_INVALID_STATE', 'delay_seconds must be a positive integer.');
    }
}
//# sourceMappingURL=self-reminder.js.map