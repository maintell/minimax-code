import { Cron } from 'croner';
/** Match the whole local minute without registering a timer or a scheduled job. */
export function checkConsolidationWindow(expression, nowMs, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    if (expression === undefined || expression.trim() === '')
        return 'allowed';
    if (expression.trim().split(/\s+/u).length !== 5)
        return 'invalid-schedule';
    try {
        // Match wall-clock fields in UTC so both occurrences of a DST minute share eligibility.
        const minuteStartMs = localMinuteAsUtc(nowMs, timezone);
        const cron = new Cron(expression, { timezone: 'UTC', paused: true });
        try {
            return cron.nextRun(new Date(minuteStartMs - 1000))?.getTime() === minuteStartMs
                ? 'allowed'
                : 'outside-window';
        }
        finally {
            cron.stop();
        }
    }
    catch {
        return 'invalid-schedule';
    }
}
function localMinuteAsUtc(nowMs, timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(nowMs);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
}
//# sourceMappingURL=consolidation-window.js.map