import { createSubscriptionQuota, } from '../../subscription-quota/index.js';
/**
 * Memory's view of the shared Token Plan quota reader. The Runtime owns the
 * account request; Memory only projects the remaining share of both windows.
 */
export class MemorySubscriptionQuota {
    quota;
    constructor(options) {
        this.quota = createSubscriptionQuota(options);
    }
    async read(modelName) {
        const result = await this.quota.read(modelName);
        if (result.status === 'available') {
            return {
                status: 'available',
                fiveHour: result.windows.fiveHour.remainingPercent,
                weekly: result.windows.weekly.remainingPercent,
            };
        }
        return result;
    }
    /** 账户订阅档位事实，供上线时的一次性默认处理判断最低档（memory-system/rollout.ts）。 */
    readPlan() {
        return this.quota.readPlan();
    }
}
//# sourceMappingURL=memory-quota.js.map