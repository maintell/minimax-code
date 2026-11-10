import {} from '@mavis/cron';
import { Cron } from 'croner';
export const localCronScheduler = {
    createJob(config, options, onTick) {
        return new Cron(cronerPatternForConfig(config), {
            timezone: config.scheduleType === 'once' ? undefined : config.timezone,
            unref: options.unref,
        }, onTick);
    },
    assertSchedulable(config) {
        const job = new Cron(cronerPatternForConfig(config), {
            timezone: config.scheduleType === 'once' ? undefined : config.timezone,
            unref: true,
        });
        try {
            job.nextRun();
        }
        finally {
            job.stop();
        }
    },
};
function cronerPatternForConfig(config) {
    if (config.scheduleType !== 'once')
        return config.schedule;
    if (typeof config.runAtMs !== 'number') {
        throw new Error('runAtMs is required for once cron tasks');
    }
    return new Date(config.runAtMs);
}
export function toCronSessionStatus(status) {
    if (status === 'started')
        return { type: 'started' };
    if (status === 'error')
        return { type: 'error' };
    if (status === 'aborted')
        return { type: 'aborted' };
    if (status === 'interrupted')
        return { type: 'interrupted' };
    return { type: 'finished' };
}
//# sourceMappingURL=runtime-contracts.js.map