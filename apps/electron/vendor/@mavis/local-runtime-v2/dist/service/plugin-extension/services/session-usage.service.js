import { settleInBackground } from '../../../infra/async/settle.js';
const MAX_BASELINES = 512;
export class ExtensionSessionUsageService {
    deps;
    baselines = new Map();
    slots = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    async usage(callId) {
        return this.deps.boundary.run({ callId, domain: 'session', method: 'usage' }, async (inv) => {
            const { sessionId } = inv.origin;
            const [startedAt, measured] = await Promise.all([
                this.deps.port.startedAt(sessionId),
                this.read(sessionId),
            ]);
            return { startedAt, ...measured, rateLimits: [] };
        });
    }
    /** A main-agent turn of the session ended and its reply is persisted. Never throws. */
    measure(sessionId) {
        if (!this.listens(sessionId))
            return;
        const slot = this.slots.get(sessionId);
        if (slot) {
            slot.pending = true;
            return;
        }
        const fresh = { pending: false };
        this.slots.set(sessionId, fresh);
        settleInBackground(this.drain(sessionId, fresh));
    }
    deleteSession(sessionId) {
        this.baselines.delete(sessionId);
        this.slots.delete(sessionId);
    }
    async drain(sessionId, slot) {
        try {
            do {
                slot.pending = false;
                await this.measureOnce(sessionId, slot);
            } while (slot.pending && this.slots.get(sessionId) === slot);
        }
        finally {
            if (this.slots.get(sessionId) === slot)
                this.slots.delete(sessionId);
        }
    }
    async measureOnce(sessionId, slot) {
        try {
            const signature = this.listens(sessionId);
            if (!signature)
                return;
            const current = await this.read(sessionId);
            if (this.slots.get(sessionId) !== slot)
                return;
            if (this.listens(sessionId) !== signature) {
                slot.pending = true;
                return;
            }
            const baseline = this.baselines.get(sessionId);
            const changed = changedParts(baseline?.signature === signature ? baseline.measurement : undefined, current);
            if (changed.length === 0)
                return;
            this.remember(sessionId, signature, current);
            const event = {
                sessionId,
                context: current.context,
                rateLimits: [],
                changed,
            };
            if (this.slots.get(sessionId) !== slot)
                return;
            await this.deps.dispatch(sessionId, JSON.parse(JSON.stringify(event)));
        }
        catch (error) {
            this.deps.onError(error);
        }
    }
    listens(sessionId) {
        try {
            return this.deps.listens(sessionId);
        }
        catch (error) {
            this.deps.onError(error);
            return '';
        }
    }
    remember(sessionId, signature, measurement) {
        this.baselines.delete(sessionId);
        this.baselines.set(sessionId, { signature, measurement });
        if (this.baselines.size <= MAX_BASELINES)
            return;
        const oldest = this.baselines.keys().next().value;
        if (oldest !== undefined)
            this.baselines.delete(oldest);
    }
    async read(sessionId) {
        return { context: await this.context(sessionId) };
    }
    async context(sessionId) {
        const snapshot = await this.deps.port.latestContext(sessionId);
        if (snapshot && snapshot.contextWindowTokens > 0)
            return contextOf(snapshot);
        return { window: await this.deps.port.contextWindow(sessionId) };
    }
}
function contextOf(snapshot) {
    const window = snapshot.contextWindowTokens;
    const tokens = snapshot.usedTokens;
    const breakdown = snapshot.components.length > 0
        ? snapshot.components.map(({ kind, tokens: part }) => ({ kind, tokens: part }))
        : undefined;
    return {
        window,
        ...(tokens > 0
            ? { tokens, percent: Math.min(100, Math.max(0, Math.round((100 * tokens) / window))) }
            : {}),
        ...(breakdown ? { breakdown } : {}),
    };
}
function changedParts(previous, current) {
    const changed = [];
    const before = previous?.context;
    const after = current.context;
    if (before?.window !== after.window ||
        before?.tokens !== after.tokens ||
        before?.percent !== after.percent) {
        changed.push('context');
    }
    return changed;
}
//# sourceMappingURL=session-usage.service.js.map