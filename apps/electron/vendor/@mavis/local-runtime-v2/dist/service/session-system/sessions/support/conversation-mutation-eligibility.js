import { isPrimarySessionAgentName } from '../agent-name.js';
/** Shared business gate for the top-level primary Sessions that own conversation mutations. */
export function isConversationMutationEligibleSession(session, minimumDataVersion) {
    return (session.runtime === 'pi-agent' &&
        session.sessionOrigin === 'local-runtime' &&
        (session.sessionDataVersion ?? 0) >= minimumDataVersion &&
        isPrimarySessionAgentName(session.agentName) &&
        session.parentSessionId == null &&
        (session.sessionKind === 'conversation' || session.sessionKind === 'cron'));
}
//# sourceMappingURL=conversation-mutation-eligibility.js.map