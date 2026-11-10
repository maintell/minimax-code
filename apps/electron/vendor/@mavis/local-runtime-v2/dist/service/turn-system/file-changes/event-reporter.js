export function createLocalTurnEventReporting(input) {
    let eventIdentitySequence = 0;
    let runtimeSequence = 0;
    const eventIdGenerator = input.eventIdGenerator ??
        ((kind) => `evt_${input.turnId}_${kind}_${++eventIdentitySequence}`);
    const runtimeSeqGenerator = input.runtimeSeqGenerator ?? (() => ++runtimeSequence);
    const reporter = {
        nextEventId: eventIdGenerator,
        nextRuntimeSeq: runtimeSeqGenerator,
        appendEvents: (events) => input.eventWriter.appendEvents(events),
    };
    return { reporter, eventIdGenerator, runtimeSeqGenerator };
}
//# sourceMappingURL=event-reporter.js.map