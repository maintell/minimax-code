export function createLocalTurnEventWriter(input, projectRuntimeEvent) {
    const recorded = [];
    const project = async (event) => projectRuntimeEvent
        ? projectRuntimeEvent({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            event,
        })
        : event;
    const push = async (event) => {
        const projected = await project(event);
        if (!projected)
            return;
        recorded.push(projected);
        await input.onRuntimeEvent(projected);
    };
    return {
        events: recorded,
        pushRuntime: push,
        appendEvents: async (events) => {
            for (const event of events)
                await push(event);
        },
    };
}
//# sourceMappingURL=runtime-event-writer.js.map