import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
export function createCoordinatorRoster(agents) {
    const byName = new Map();
    for (const agent of agents)
        if (agent.coordination)
            byName.set(agent.name, agent.coordination);
    return { coordinationOf: (agentName) => (agentName ? byName.get(agentName) : undefined) };
}
/** No Agent coordinates: every Session is ordinary. */
export const EMPTY_COORDINATOR_ROSTER = createCoordinatorRoster([]);
export function createCoordinatorOwnership(options) {
    const { roster, tasks, sessions } = options;
    const get = (id) => sessions.get(id);
    const coordinates = (agentName) => isCoordinatorAgent(roster.coordinationOf(agentName));
    const isAssignedTask = (sessionId) => coordinates(tasks.assignerOf(sessionId));
    const standing = (session) => {
        if (coordinates(session.agentName))
            return 'coordinator';
        return isAssignedTask(session.sessionId) ? 'task' : undefined;
    };
    const anchor = async (session) => {
        const own = standing(session);
        if (own)
            return { session, standing: own };
        if (!session.parentSessionId)
            return undefined;
        const ancestor = await findSessionAncestor(get, session.parentSessionId, (candidate) => Boolean(standing(candidate)));
        const found = ancestor && standing(ancestor);
        return ancestor && found ? { session: ancestor, standing: found } : undefined;
    };
    /**
     * How many of the roster and the task index are readable. Neither becomes
     * unreadable again once read, so a change means one of them recovered.
     */
    const readable = () => (roster.available?.() === false ? 0 : 1) + (tasks.available?.() === false ? 0 : 1);
    const degraded = () => readable() < 2;
    const marked = (session) => tasks.hasAssignmentMessage?.(session.sessionId) === true;
    /**
     * A judgement made before the roster or the index recovered is made again:
     * "no owner" read while either was unavailable proves nothing once it is
     * readable. Each recovery happens once, so this repeats at most twice.
     */
    const owner = async (session) => {
        const seen = readable();
        const found = await anchor(session);
        if (found)
            return found;
        if (readable() !== seen)
            return owner(session);
        if (!degraded())
            return undefined;
        const mayBeTask = marked(session) ||
            (session.parentSessionId
                ? (await findSessionAncestor(get, session.parentSessionId, marked)) !== undefined
                : false);
        if (readable() !== seen)
            return owner(session);
        if (!mayBeTask)
            return undefined;
        tasks.retryLoad?.();
        if (readable() !== seen)
            return owner(session);
        throw new Error(`Coordinator ownership is unknown while it cannot be read: ${session.sessionId}`);
    };
    return {
        roster,
        standing,
        isAssignedTask,
        ...(options.agentOf ? { agentOf: options.agentOf } : {}),
        owner,
    };
}
/**
 * Whether the Session's own Agent is a trusted built-in coordinator.
 *
 * Read from the built-in roster through `coordinatorOwnership.standing`, which
 * is the same list the harness tool authority reads (`isTrustedCoordinator`):
 * only the bundled built-in catalog can declare coordination, so both sides
 * answer from one source.
 *
 * A Session that cannot be read is an ordinary Session: the caller keeps the
 * ordinary wording rather than claiming a coordination it could not verify.
 */
export async function sessionIsCoordinator(system, sessionId) {
    try {
        const session = await system.sessions.repository.get(sessionId);
        if (!session)
            return false;
        return system.coordinatorOwnership.standing(session) === 'coordinator';
    }
    catch {
        return false;
    }
}
/** How many parent links a lookup climbs, far beyond real subagent nesting. */
const MAX_SESSION_ANCESTRY_DEPTH = 32;
/**
 * The nearest Session on the parent chain that `matches`, the starting Session
 * included. Subagents run in child Sessions whose parent is the calling Session,
 * so a task's subagents at any depth reach the task this way. A missing Session,
 * a cycle or the depth limit ends the walk without a match.
 */
export async function findSessionAncestor(get, sessionId, matches) {
    const visited = new Set();
    let id = sessionId;
    for (let depth = 0; id && depth <= MAX_SESSION_ANCESTRY_DEPTH; depth++) {
        if (visited.has(id))
            return undefined;
        visited.add(id);
        const session = await get(id);
        if (!session)
            return undefined;
        if (await matches(session))
            return session;
        id = session.parentSessionId;
    }
    return undefined;
}
//# sourceMappingURL=ownership.js.map