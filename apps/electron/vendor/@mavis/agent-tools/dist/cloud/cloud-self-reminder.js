import { withProgrammaticResult } from '@mavis/agent-core/tools';
import { Value } from '@sinclair/typebox/value';
import { LocalSelfReminderToolDef, cronToolFailure } from '../cron/tool-defs.js';
import { baseRespOrSuccess } from './mavis/commands/types.js';
import { errorToFailure, success, toToolResult } from './mavis/output.js';
const SELF_REMINDER_PATH = '/api/v1/cron/self-reminder';
const CRON_JOB_DUPLICATE = 1400010901;
export async function executeCloudSelfReminder(deps, input, signal) {
    try {
        if (!Value.Check(LocalSelfReminderToolDef.schema, input) ||
            !['set', 'cancel'].includes(input.action))
            return selfReminderFailure('Invalid self_reminder arguments.');
        if (!deps.sessionId?.trim())
            return selfReminderFailure('The current session is required.');
        if (input.action === 'set' && (input.delay_seconds === undefined || !input.prompt?.trim()))
            return selfReminderFailure('set requires delay_seconds and a nonblank prompt.');
        if (input.action === 'cancel' &&
            (input.delay_seconds !== undefined || input.prompt !== undefined))
            return selfReminderFailure('cancel accepts only action.');
        const response = await deps.archonServer.callRpc('SelfReminder', { ...input, session_id: deps.sessionId }, signal);
        if (!response || typeof response !== 'object')
            return selfReminderFailure('The cloud server returned an invalid reminder response.', 'CRON_INVALID_RESPONSE');
        const output = baseRespOrSuccess('self_reminder', response, SELF_REMINDER_PATH);
        if (!output.ok) {
            if (output.error.status_code === CRON_JOB_DUPLICATE)
                return asReminderResult({
                    ...output,
                    error: { ...output.error, code: 'SELF_REMINDER_EXISTS' },
                });
            return asReminderResult(output);
        }
        if (input.action === 'cancel') {
            if (typeof response.cancelled !== 'boolean')
                return selfReminderFailure('The cloud server did not return cancellation status.', 'CRON_INVALID_RESPONSE');
            return asReminderResult(success('self_reminder', { cancelled: response.cancelled }));
        }
        const id = taskId(response.task?.task_id);
        if (!id)
            return selfReminderFailure('The cloud server did not return a reminder task ID.', 'CRON_INVALID_RESPONSE');
        return asReminderResult(success('self_reminder', {
            ...response,
            reminder_id: id,
            active: response.task.enabled !== false,
        }));
    }
    catch (error) {
        return asReminderResult(errorToFailure('self_reminder', error));
    }
}
function taskId(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
        return undefined;
    const text = typeof value === 'string' ? value.trim() : value?.toString();
    return text && /^[1-9]\d*$/.test(text) ? text : undefined;
}
function asReminderResult(output) {
    return withProgrammaticResult({ ...toToolResult(output, 'self_reminder'), ...(output.ok ? {} : { isError: true }) }, 
    // SelfReminderData; text and details are unchanged.
    // Completeness: the whole response object is serialized into the text, so a
    // success is never cut. Failures stay undeclared, as Desktop's do.
    {
        data: output.ok ? { ok: true, response: output.response } : { ok: false },
        ...(output.ok ? { completeness: { truncated: false } } : {}),
    });
}
/** PTC data for a self_reminder failure: only the outcome; the reason is r.error. */
function selfReminderFailure(message, code) {
    return withProgrammaticResult(cronToolFailure('self_reminder', message, code), {
        data: { ok: false },
    });
}
//# sourceMappingURL=cloud-self-reminder.js.map