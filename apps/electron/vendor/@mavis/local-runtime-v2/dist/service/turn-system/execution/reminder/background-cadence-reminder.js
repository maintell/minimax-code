import { formatBackgroundCadenceReminderContent, } from '../../agent-host/history/canonical-history-validation.js';
import { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE, projectBackgroundHistory, } from '../../compaction/algorithm/background-cadence.js';
import { TODO_CADENCE_INTERVAL } from '../../compaction/compat.js';
import { readBackgroundTaskOriginMetadata } from '../../agent-host/history/background/host-metadata.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';
export function createBackgroundCadenceReminder(usageAnchor) {
    return {
        async prepare(input) {
            if (hasAutomaticBackgroundOrigin(input.hookInput.canonicalMessages.at(-1))) {
                return { beforeUserMessages: [], hook: () => undefined };
            }
            const facts = freezeFacts(await input.loadFacts());
            const candidate = createBackgroundCadenceMarker(input.hookInput, facts);
            const marker = candidate && fitsReminderInFinalRequest(input.hookInput, candidate, usageAnchor)
                ? candidate
                : undefined;
            return {
                beforeUserMessages: marker ? [marker] : [],
                hook: createPreparedBackgroundCadenceReminderHook({
                    facts,
                    initialCandidate: candidate,
                    usageAnchor,
                    hasSuccessfulTaskOutputRead: input.hasSuccessfulTaskOutputRead,
                }),
            };
        },
    };
}
function createPreparedBackgroundCadenceReminderHook(options) {
    const { facts, initialCandidate, usageAnchor, hasSuccessfulTaskOutputRead = () => false, } = options;
    return (input) => {
        if (hasSuccessfulTaskOutputRead())
            return undefined;
        if (hasAutomaticBackgroundOrigin(input.canonicalMessages.at(-1)))
            return undefined;
        const marker = input.phase === 'initial' ? initialCandidate : createBackgroundCadenceMarker(input, facts);
        if (!marker ||
            (input.phase === 'initial' && hasPreparedMarker(input.canonicalMessages, marker)) ||
            !fitsReminderInFinalRequest(input, marker, usageAnchor)) {
            return undefined;
        }
        return marker
            ? {
                type: 'appendMessage',
                reason: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
                message: marker,
                ...(input.phase === 'initial' ? { placement: 'before-current-user' } : {}),
            }
            : undefined;
    };
}
function createBackgroundCadenceMarker(input, facts) {
    if (facts.undeliveredTotal === 0 || facts.tasks.length === 0)
        return undefined;
    const projection = projectBackgroundHistory(input.canonicalMessages);
    const hasNewTerminalTask = !projection.hasBackgroundState ||
        (projection.observedTerminalCount !== undefined &&
            facts.terminalTotal > projection.observedTerminalCount);
    if (!hasNewTerminalTask && projection.assistantIterationsSinceReminder < TODO_CADENCE_INTERVAL) {
        return undefined;
    }
    const details = {
        version: 1,
        tasks: facts.tasks,
        undeliveredTotal: facts.undeliveredTotal,
        queuedTotal: facts.undeliveredTotal - facts.tasks.length,
        terminalTotal: facts.terminalTotal,
        cadence: {
            assistantIterationsBeforeReminder: projection.assistantIterationsSinceReminder,
        },
    };
    const marker = {
        role: 'custom',
        customType: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
        content: formatBackgroundCadenceReminderContent(details),
        display: false,
        details,
        timestamp: Date.now(),
    };
    return marker;
}
function freezeFacts(facts) {
    return Object.freeze({
        tasks: Object.freeze(facts.tasks.map((task) => Object.freeze({ ...task }))),
        undeliveredTotal: facts.undeliveredTotal,
        terminalTotal: facts.terminalTotal,
    });
}
function hasPreparedMarker(messages, marker) {
    return messages.some((message) => message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        Reflect.get(message, 'role') === 'custom' &&
        Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
        Reflect.get(message, 'timestamp') === marker.timestamp);
}
function hasAutomaticBackgroundOrigin(message) {
    return readBackgroundTaskOriginMetadata(message) !== undefined;
}
//# sourceMappingURL=background-cadence-reminder.js.map