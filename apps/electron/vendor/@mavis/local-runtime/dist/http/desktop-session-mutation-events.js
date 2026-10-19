export function createSessionMutationEventPublisher(publish, options = {}) {
    const pinnedUpdated = (input) => {
        publish({
            type: 'session.pinned_updated',
            payload: {
                sessionId: input.sessionId,
                pinned: input.pinned,
                ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
            },
        });
    };
    if (options.publishLifecycleEvents === false)
        return { pinnedUpdated };
    return {
        titleUpdated: (input) => {
            publish({
                type: 'session.title_updated',
                payload: {
                    sessionId: input.sessionId,
                    title: input.title,
                    ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
                },
            });
        },
        pinnedUpdated,
        deleted: (input) => {
            publish({
                type: 'session.deleted',
                payload: {
                    sessionId: input.sessionId,
                    ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
                },
            });
        },
    };
}
//# sourceMappingURL=desktop-session-mutation-events.js.map