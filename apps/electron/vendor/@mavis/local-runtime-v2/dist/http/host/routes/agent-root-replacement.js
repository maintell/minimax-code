import { logger } from '../../../infra/logging/logger.js';
import { buildArchivedRootSessionTitle } from '../../../service/session-system/index.js';
/** Historical store-only root repair; hosts with Conversation use its lifecycle directly. */
export async function replaceStoredAgentRootSession(ctx, agentName, sessionId) {
    const baseLog = { scope: 'agent-routes', op: 'replaceRootSession', agentName, sessionId };
    const nextRoot = await ctx.querySession(sessionId);
    if (!validateNextRoot(nextRoot, baseLog))
        return undefined;
    // Session rows are authoritative; the Agent's main_session_id may be stale.
    const previous = await resolvePreviousRoot(ctx, nextRoot, baseLog);
    if (!previous)
        return undefined;
    const { oldRoot, fallbackName } = previous;
    const rootSessionsToDemote = (await ctx.controller.listSessions({ agentName }))
        .filter((session) => isPiRootSession(session, agentName))
        .filter((session) => session.sessionId !== nextRoot.sessionId);
    for (const root of rootSessionsToDemote) {
        if (!(await demoteRoot(ctx, root, fallbackName, baseLog)))
            return undefined;
    }
    let updated;
    try {
        updated = await ctx.updateOwnedSession(nextRoot.sessionId, {
            sessionType: 'root',
            parentSessionId: null,
            archived: false,
            title: 'Main',
        });
    }
    catch (err) {
        logger.error({ ...baseLog, err: err instanceof Error ? err.message : String(err) }, 'replaceRootSession: promoting new root failed');
        return undefined;
    }
    await ctx.setRootSessionId(agentName, nextRoot.sessionId);
    if (oldRoot && oldRoot.sessionId !== nextRoot.sessionId) {
        // Publishing follows the persisted pointer so Desktop observes the new Main.
        publishRootReplacement(ctx, baseLog);
    }
    logger.info({
        ...baseLog,
        oldRootId: oldRoot?.sessionId,
        newRootId: nextRoot.sessionId,
        outcome: 'ok',
    }, 'replaceRootSession completed');
    return updated ?? nextRoot;
}
function validateNextRoot(nextRoot, baseLog) {
    if (!nextRoot) {
        logger.warn({ ...baseLog, reason: 'next_root_not_found' }, 'replaceRootSession bailed');
        return false;
    }
    if (nextRoot.agentName !== baseLog.agentName) {
        logger.warn({ ...baseLog, reason: 'agent_name_mismatch', actualAgent: nextRoot.agentName }, 'replaceRootSession bailed');
        return false;
    }
    if (nextRoot.runtime !== 'pi-agent') {
        logger.warn({ ...baseLog, reason: 'unsupported_runtime', runtime: nextRoot.runtime }, 'replaceRootSession bailed');
        return false;
    }
    return true;
}
async function resolvePreviousRoot(ctx, nextRoot, baseLog) {
    const { agentName } = baseLog;
    if (agentName === ctx.agentName) {
        return {
            oldRoot: await ctx.ensureRootSession(),
            fallbackName: ctx.agentDisplayName || agentName,
        };
    }
    const preferred = await ctx.getPreferredSessionForAgent(agentName);
    const oldRoot = await findStoredRoot(ctx, agentName, preferred);
    if (!oldRoot && !isPiRootSession(nextRoot, agentName)) {
        logger.error({
            ...baseLog,
            reason: 'no_existing_root',
            preferredSessionId: preferred?.sessionId,
            preferredSessionType: preferred?.sessionType,
        }, 'replaceRootSession bailed: cannot find existing root session for agent');
        return undefined;
    }
    return { oldRoot, fallbackName: await readRootDisplayName(ctx, baseLog) };
}
async function findStoredRoot(ctx, agentName, preferred) {
    if (preferred && isPiRootSession(preferred, agentName) && !preferred.archived)
        return preferred;
    const sessions = await ctx.controller.listSessions({ agentName });
    return (sessions.find((session) => isPiRootSession(session, agentName) && !session.archived) ??
        (preferred && isPiRootSession(preferred, agentName) ? preferred : undefined) ??
        sessions.find((session) => isPiRootSession(session, agentName)));
}
async function readRootDisplayName(ctx, baseLog) {
    // Display-name lookup is best effort and cannot prevent promotion.
    try {
        const detail = await ctx.getLocalAgent(baseLog.agentName);
        return detail?.displayName || baseLog.agentName;
    }
    catch (err) {
        logger.warn({ ...baseLog, err: err instanceof Error ? err.message : String(err) }, 'replaceRootSession: getLocalAgent for display name failed (non-fatal)');
        return baseLog.agentName;
    }
}
async function demoteRoot(ctx, root, fallbackName, baseLog) {
    // Stop the old foreground turn before archiving; a later resume cannot target it.
    try {
        ctx.abortLocalSessionTurn(root.sessionId);
    }
    catch (err) {
        logger.warn({ ...baseLog, oldRootId: root.sessionId, err: err instanceof Error ? err.message : String(err) }, 'replaceRootSession: aborting old root turn failed (non-fatal)');
    }
    const fallbackTitle = buildArchivedRootSessionTitle({
        oldTitle: root.title,
        fallbackName,
        locale: ctx.resolveLocale?.(),
    });
    try {
        await ctx.updateOwnedSession(root.sessionId, {
            sessionType: 'branch',
            archived: true,
            title: fallbackTitle,
        });
        return true;
    }
    catch (err) {
        logger.error({ ...baseLog, oldRootId: root.sessionId, err: err instanceof Error ? err.message : String(err) }, 'replaceRootSession: demoting old root failed');
        return false;
    }
}
function publishRootReplacement(ctx, baseLog) {
    try {
        ctx.publishGlobalEvent({ type: 'agent.updated', payload: { agentName: baseLog.agentName } });
    }
    catch (err) {
        logger.warn({ ...baseLog, err: err instanceof Error ? err.message : String(err) }, 'replaceRootSession: publishGlobalEvent(agent.updated) failed (non-fatal)');
    }
}
function isPiRootSession(session, agentName) {
    return (session.agentName === agentName &&
        session.runtime === 'pi-agent' &&
        session.sessionType === 'root');
}
//# sourceMappingURL=agent-root-replacement.js.map