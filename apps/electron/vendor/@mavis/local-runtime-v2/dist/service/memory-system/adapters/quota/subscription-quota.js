import { createHash } from 'node:crypto';
import { getRuntimeBuildEnv, getRuntimeRegion, } from '@mavis/config';
import { membership, personalWorkspace, projectQuota, record, text, } from './projection.js';
import { MemoryQuotaTransport, } from './transport.js';
/** 缓存属于一次登录与环境快照；旧请求完成后只能写回自己的旧快照。 */
export class MemorySubscriptionQuota {
    options;
    state;
    transport;
    constructor(options) {
        this.options = options;
        this.transport = new MemoryQuotaTransport(options);
    }
    async read(modelName) {
        const state = this.currentState();
        if (!state)
            return { status: 'unknown', reason: 'account-unavailable' };
        try {
            const plan = await state.membership.read(() => this.readMembership(state));
            if (this.currentState() !== state)
                return { status: 'unknown', reason: 'account-changed' };
            if (plan.hasTokenPlan === false)
                return { status: 'not-applicable', reason: 'not-subscribed' };
            if (plan.hasTokenPlan !== true || !plan.groupId)
                return { status: 'unknown', reason: 'subscription-unavailable' };
            const groupId = plan.groupId;
            const body = await state.quota.read(() => this.transport.remains(state.context, groupId));
            if (this.currentState() !== state)
                return { status: 'unknown', reason: 'account-changed' };
            return projectQuota(body, modelName);
        }
        catch {
            return { status: 'unknown', reason: 'quota-request-unavailable' };
        }
    }
    currentState() {
        const auth = this.options.authContextGetter();
        const accessToken = auth?.accessToken?.trim();
        if (!accessToken || auth?.authState === 'logged_out' || auth?.authState === 'pending') {
            this.state = undefined;
            return undefined;
        }
        const environment = this.options.environmentGetter?.() ?? {
            region: getRuntimeRegion(),
            buildEnv: getRuntimeBuildEnv(),
        };
        const context = {
            ...environment,
            auth: { ...auth, accessToken },
            routingHeaders: { ...this.options.routingHeadersGetter() },
        };
        const key = createHash('sha256')
            .update(JSON.stringify({
            ...context,
            routingHeaders: Object.entries(context.routingHeaders).sort(([a], [b]) => a.localeCompare(b)),
        }))
            .digest('hex');
        if (this.state?.key !== key) {
            this.state = {
                key,
                context,
                membership: new ShortCache(30_000, this.options.nowMs),
                quota: new ShortCache(5_000, this.options.nowMs),
            };
        }
        return this.state;
    }
    async readMembership(state) {
        const context = await this.withUserIdentity(state.context);
        const body = await this.transport.matrix(context, '/matrix/api/v1/user/get_user_extra_info', {});
        const personal = personalWorkspace(body);
        if (!personal)
            return {};
        const scoped = membership(await this.transport.matrix(context, '/matrix/api/v1/commerce/get_membership_info', {
            workspace_id: personal.id,
        }));
        // 任一个人订阅事实为 true 即确认订阅；账户组优先使用个人 workspace 的归属。
        const facts = [personal.membership.hasTokenPlan, scoped.hasTokenPlan];
        let hasTokenPlan;
        if (facts.includes(false))
            hasTokenPlan = false;
        if (facts.includes(true))
            hasTokenPlan = true;
        const groupId = personal.membership.groupId ?? scoped.groupId;
        state.quota.clear();
        return { hasTokenPlan, groupId };
    }
    async withUserIdentity(context) {
        if (context.auth.realUserID)
            return context;
        const body = await this.transport.matrix(context, '/v1/api/user/info');
        const data = record(body.data) ?? body;
        const user = record(data.userInfo) ?? record(data.user_info);
        const realUserID = text(user?.realUserID ?? user?.real_user_id);
        if (!realUserID)
            throw new Error('quota-identity-unavailable');
        return { ...context, auth: { ...context.auth, realUserID } };
    }
}
/** 同身份在途合并，完成时起算 TTL；失败也短缓存，避免一轮多候选重复请求。 */
class ShortCache {
    ttlMs;
    nowMs;
    cached;
    pending;
    retryAtMs = 0;
    constructor(ttlMs, nowMs) {
        this.ttlMs = ttlMs;
        this.nowMs = nowMs;
    }
    clear() {
        this.cached = undefined;
        this.retryAtMs = 0;
    }
    async read(load) {
        if (this.cached && this.cached.expiresAtMs > this.nowMs())
            return this.cached.value;
        if (this.pending)
            return this.pending;
        if (this.retryAtMs > this.nowMs())
            throw new Error('quota-request-backoff');
        const pending = load();
        this.pending = pending;
        try {
            const value = await pending;
            this.cached = { value, expiresAtMs: this.nowMs() + this.ttlMs };
            return value;
        }
        catch {
            this.retryAtMs = this.nowMs() + 5000;
            throw new Error('quota-request-unavailable');
        }
        finally {
            this.pending = undefined;
        }
    }
}
//# sourceMappingURL=subscription-quota.js.map