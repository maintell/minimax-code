/**
 * The `agentKind` metrics label of a Turn, judged by the coordinator capability
 * without a read: a coordinator's own Session is `bunny_main`, a Session running
 * a task a coordinator assigned is `bunny_task` (Bunny is the only coordinator).
 * Every other Session is ordinary and carries no label.
 */
export function createTurnAgentKindResolver(ownership) {
    return (session) => {
        const standing = ownership.standing(session);
        if (standing === 'coordinator')
            return 'bunny_main';
        return standing === 'task' ? 'bunny_task' : undefined;
    };
}
//# sourceMappingURL=turn-agent-kind.js.map