import { eq } from 'drizzle-orm';
import { bunnyScheduleOrigins } from '../../infra/db/schema/bunny-store.js';
import { originChannelColumn, readOriginChannel, } from '../session-system/index.js';
/**
 * Only address fields reach the row, so a WeChat context token on the caller's
 * object is dropped. A malformed row reads as none: that run stays on the desktop.
 */
export function createBunnyScheduleOriginStore(options) {
    const nowMs = options.nowMs ?? Date.now;
    const { db } = options;
    return {
        record: (cronId, originChannel) => {
            const address = readOriginChannel(originChannel);
            if (!cronId.trim() || !address)
                return false;
            const row = { originChannel: originChannelColumn(address), recordedAtMs: nowMs() };
            db.insert(bunnyScheduleOrigins)
                .values({ cronId, ...row })
                .onConflictDoUpdate({ target: bunnyScheduleOrigins.cronId, set: row })
                .run();
            return true;
        },
        get: (cronId) => {
            const row = db
                .select({ originChannel: bunnyScheduleOrigins.originChannel })
                .from(bunnyScheduleOrigins)
                .where(eq(bunnyScheduleOrigins.cronId, cronId))
                .get();
            return row ? readOriginChannel(row.originChannel) : undefined;
        },
    };
}
//# sourceMappingURL=schedule-origins.js.map