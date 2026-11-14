import { CoalescedStateWriter, isRecord, readWebFetchStateFile } from './web-fetch-state-file.js';
/**
 * Distribution of web_fetch calls per user per day. One observation per
 * (user, day) is sent once that day is over; the user id never leaves the
 * device, so the series carries no identity and no per-user cardinality.
 */
export const WEB_FETCH_USER_DAILY_CALLS_METRIC = 'web_fetch_user_daily_calls';
// Bucket bounds (0 … 2000, sized around plausible daily limits) are registered
// in infra/observability/host-metrics.ts.
/** Day boundary shared with mcp-server's default `day_timezone`. */
const DAY_TIME_ZONE = 'Asia/Shanghai';
/**
 * Counts each signed-in user's web_fetch calls for the current day and reports
 * finished days. Counts are kept on disk so a restart keeps them; days that ended
 * while the Runtime was down are reported on the next start. A day is reported
 * before its removal is written, so a failed write or a kill in between reports
 * it twice. That only nudges a distribution, so it is accepted.
 */
export class WebFetchDailyUsage {
    observe;
    stateFilePath;
    now;
    users;
    writer;
    constructor(options) {
        this.observe = options.observe;
        this.stateFilePath = options.stateFilePath ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.writer = new CoalescedStateWriter({
            filePath: this.stateFilePath,
            snapshot: () => ({ users: Object.fromEntries(this.users ?? []) }),
            now: this.now,
        });
    }
    /** Writes any counts still in flight; the Runtime awaits this when closing. */
    flush() {
        return this.writer.flush();
    }
    /** Reports every day that is already over. Call once at Runtime start. */
    reportFinishedDays() {
        if (this.flushFinishedDays(this.load(), this.today()))
            this.writer.markDirty();
    }
    recordCall(userKey) {
        this.dayFor(userKey).all += 1;
        this.writer.markDirty();
    }
    recordServerRead(userKey) {
        this.dayFor(userKey).server += 1;
        this.writer.markDirty();
    }
    dayFor(userKey) {
        const users = this.load();
        const today = this.today();
        this.flushFinishedDays(users, today);
        let entry = users.get(userKey);
        if (!entry) {
            entry = { day: today, all: 0, server: 0 };
            users.set(userKey, entry);
        }
        return entry;
    }
    flushFinishedDays(users, today) {
        let flushed = false;
        for (const [userKey, entry] of users) {
            if (entry.day === today)
                continue;
            this.observe(entry.all, { scope: 'all' });
            this.observe(entry.server, { scope: 'server' });
            users.delete(userKey);
            flushed = true;
        }
        return flushed;
    }
    today() {
        return dayKey(this.now());
    }
    load() {
        if (this.users)
            return this.users;
        const filePath = this.stateFilePath();
        this.users = new Map(readUserDays(filePath ? readWebFetchStateFile(filePath) : undefined));
        return this.users;
    }
}
/** The calendar day of `ms` in the shared time zone, as YYYY-MM-DD. */
function dayKey(ms) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: DAY_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(ms);
}
function readUserDays(stored) {
    const users = isRecord(stored) && isRecord(stored.users) ? stored.users : {};
    const entries = [];
    for (const [userKey, value] of Object.entries(users)) {
        if (!isRecord(value) || typeof value.day !== 'string')
            continue;
        entries.push([userKey, { day: value.day, all: count(value.all), server: count(value.server) }]);
    }
    return entries;
}
function count(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
//# sourceMappingURL=daily-usage.js.map