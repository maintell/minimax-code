import { settleInBackground } from '../../infra/async/settle.js';
import { answerFields } from './sdk/observe-answer.js';
import { TurnFrameProjector } from './observe-projector.js';
const MAX_PARENT_DEPTH = 8;
const MAX_CACHED_ROUTES = 512;
export class ExtensionTurnObserver {
    deps;
    routes = new Map();
    projector;
    constructor(deps) {
        this.deps = deps;
        this.projector = new TurnFrameProjector(deps.nowMs);
    }
    observe(frame) {
        try {
            if (this.deps.anyObserver())
                settleInBackground(this.deliver(frame));
        }
        catch (error) {
            this.deps.onError(error);
        }
    }
    async observesTurnContent(sessionId) {
        if (!this.deps.anyObserver())
            return false;
        const route = await this.routeOf(sessionId);
        return this.deps.observesContent(route.sessionId);
    }
    async deliver(frame) {
        try {
            await this.project(await this.routeOf(frame.sessionId), frame);
        }
        catch (error) {
            this.deps.onError(error);
        }
    }
    async project(route, frame) {
        if (!this.deps.observes(route.sessionId))
            return;
        const events = this.projector.project({
            frameSessionId: frame.sessionId,
            sessionId: route.sessionId,
            ...(route.agentId ? { agentId: route.agentId } : {}),
            turnId: frame.turnId,
            event: frame.event,
            onError: this.deps.onError,
            ...(frame.content
                ? {
                    content: frame.content,
                    listens: (event, match) => this.deps.listens(route.sessionId, event, match),
                }
                : {}),
        });
        if (events.length === 0)
            return;
        const completes = events.some((event) => event.event === 'turn.complete');
        this.deps.dispatch(route.sessionId, route.agentId && completes ? await this.withAnswer(route, route.agentId, events) : events);
        if (completes && !route.agentId)
            this.deps.onMainTurnComplete(route.sessionId);
    }
    /** The projected event stays shared and answer-free; the answer is routed to its spawner. */
    async withAnswer(route, agentId, events) {
        const owned = await this.spawnedAnswer(route, agentId);
        if (!owned)
            return events;
        return events.map((event) => event.event === 'turn.complete'
            ? {
                ...event,
                spawner: {
                    pluginId: owned.pluginId,
                    fields: answerFields(owned, event.payload['status']),
                },
            }
            : event);
    }
    /** A failed lookup only costs the answer; the event itself still goes out. */
    async spawnedAnswer(route, agentId) {
        try {
            return await this.deps.spawnedAnswer(agentId, (pluginId) => this.deps.observesTurnComplete(route.sessionId, pluginId));
        }
        catch (error) {
            this.deps.onError(error);
            return undefined;
        }
    }
    routeOf(sessionId) {
        const cached = this.routes.get(sessionId);
        if (cached)
            return cached;
        const route = this.resolve(sessionId);
        this.routes.set(sessionId, route);
        if (this.routes.size > MAX_CACHED_ROUTES) {
            const oldest = this.routes.keys().next().value;
            if (oldest !== undefined)
                this.routes.delete(oldest);
        }
        return route;
    }
    async resolve(sessionId) {
        let root = sessionId;
        try {
            for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
                const parent = await this.deps.sessionParent(root);
                if (!parent)
                    break;
                root = parent;
            }
        }
        catch (error) {
            this.deps.onError(error);
        }
        return root === sessionId ? { sessionId } : { sessionId: root, agentId: sessionId };
    }
}
//# sourceMappingURL=turn-observer.js.map