export function toSchedulerSchedule(schedule) {
    if (schedule.kind === 'once')
        return { ...schedule };
    return {
        kind: 'cron',
        expression: schedule.expression,
        ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
        ...(schedule.maxRuns === undefined ? {} : { maxRuns: schedule.maxRuns }),
    };
}
export function toCronSchedule(schedule) {
    if (schedule.kind === 'once')
        return { ...schedule };
    return {
        kind: 'recurring',
        expression: schedule.expression,
        ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
        ...(schedule.maxRuns === undefined ? {} : { maxRuns: schedule.maxRuns }),
    };
}
//# sourceMappingURL=schedule.js.map