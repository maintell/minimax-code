import { SubscriptionQuotaClient } from './subscription-quota.js';
/** The Runtime-wide Token Plan quota reader; one instance per Runtime process. */
export function createSubscriptionQuota(options) {
    return new SubscriptionQuotaClient(options);
}
//# sourceMappingURL=initialize.js.map