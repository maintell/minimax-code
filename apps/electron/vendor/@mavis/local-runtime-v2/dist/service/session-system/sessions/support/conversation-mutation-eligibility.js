import { isPrimarySessionAgentName } from '../agent-name.js';
/** Shared business gate for the top-level primary Sessions that own conversation mutations. */
export function isConversationMutationEligibleSession(session, minimumDataVersion) {
    return (session.runtime === 'pi-agent' &&
        session.sessionOrigin === 'local-runtime' &&
        (session.sessionDataVersion ?? 0) >= minimumDataVersion &&
        isPrimarySessionAgentName(session.agentName) &&
        session.parentSessionId == null &&
        !(session.sideChatOrigin && session.visibility === 'hidden') &&
        (session.sessionKind === 'conversation' || session.sessionKind === 'cron'));
}
const MINIAPP_AUTHORING_PURPOSE = 'miniapp-authoring';
/**
 * A move changes the folder a task works in from now on, so only the ordinary top-level tasks
 * the sidebar lists can move: visible, unarchived native branch conversations without a
 * scheduled-task or Mini App owner. An Agent's Main root stays where the root invariant keeps
 * it; in the default folder it would count as an internal root the sidebar hides. A worktree
 * run location belongs to the old repository; a `current` one only names the old folder.
 */
const PROJECT_MOVE_BLOCKERS = [
    ['legacy-runtime', (session) => session.runtime !== 'pi-agent'],
    [
        'not-top-level-task',
        (session) => session.sessionType !== 'branch' || Boolean(session.parentSessionId),
    ],
    ['not-conversation', (session) => session.sessionKind !== 'conversation'],
    ['hidden', (session) => session.visibility === 'hidden'],
    ['archived', (session) => session.archived],
    [
        'scheduled-task',
        (session) => Boolean(session.originCronId) || session.purpose?.startsWith('cron:') === true,
    ],
    [
        'mini-app',
        (session) => session.purpose === MINIAPP_AUTHORING_PURPOSE || session.miniAppOrigin !== undefined,
    ],
    [
        'worktree',
        (session) => session.runLocation !== undefined && session.runLocation.mode !== 'current',
    ],
];
/** The first rule that keeps this Session in its folder; undefined when it may move. */
export function sessionProjectMoveBlocker(session) {
    return PROJECT_MOVE_BLOCKERS.find(([, blocks]) => blocks(session))?.[0];
}
//# sourceMappingURL=conversation-mutation-eligibility.js.map