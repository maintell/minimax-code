/**
 * Migration copy (MR1) of v1 `channels/im-binding-target-validation.ts`.
 */
import { isCompatibleChannelAgentOwner } from './agent-owner-compatibility.js';
import { LocalChannelRootlessError } from '../routing/rootless-route-resolver.js';
/** Validates the immutable Agent and Project boundary before an IM cursor CAS. */
export async function validateImBindingTargetSession(options, input) {
    const rootless = options.rootlessV2;
    if (!rootless) {
        throw new LocalChannelRootlessError(503, 'ROOTLESS_CHANNEL_UNAVAILABLE', 'Rootless Channel routing is unavailable.');
    }
    const [session, owner, project] = await Promise.all([
        options.getSessionById(input.sessionId),
        rootless.getAgentOwnerIdentity(input.agentName),
        rootless.getSessionProjectIdentity(input.sessionId),
    ]);
    const targetInvalid = () => new LocalChannelRootlessError(409, 'CHANNEL_IM_TARGET_SESSION_INVALID', 'The IM Binding target Session does not match the Agent and Project.');
    if (!session ||
        !isEligibleImTargetSession(session) ||
        !project ||
        project.projectKey !== input.projectKey) {
        throw targetInvalid();
    }
    const compatibleWithOwner = (persisted) => isCompatibleChannelAgentOwner({
        persisted,
        current: owner,
        ...(options.resolveAgentReadScope
            ? { resolveAgentReadScope: options.resolveAgentReadScope }
            : {}),
    });
    if (!(await compatibleWithOwner({ exactOwnerName: session.agentName }))) {
        throw targetInvalid();
    }
    const snapshot = await rootless.getSessionAgentRoutingSnapshot(session.sessionId);
    if (!snapshot || !(await compatibleWithOwner(snapshot))) {
        throw targetInvalid();
    }
}
/** Root/branch shape + liveness gates for an IM cursor target. */
function isEligibleImTargetSession(session) {
    if (session.archived || session.runtime !== 'pi-agent')
        return false;
    if (session.parentSessionId !== null && session.parentSessionId !== undefined)
        return false;
    return isImTargetSession(session);
}
function isImTargetSession(session) {
    return ((session.sessionType === 'branch' &&
        (session.sessionKind === 'channel' || session.sessionKind === 'conversation')) ||
        (session.sessionType === 'root' && session.sessionKind === 'conversation'));
}
//# sourceMappingURL=im-binding-target-validation.js.map