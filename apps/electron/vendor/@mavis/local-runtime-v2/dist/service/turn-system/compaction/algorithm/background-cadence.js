import { readCompactionCompatibility, TODO_CADENCE_INTERVAL } from '../compat.js';
import { advanceAssistantIterationCadence } from './assistant-iteration-cadence.js';
import { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE, isBackgroundTaskReadSettlement, readBackgroundTaskOriginMetadata, } from '../../agent-host/contracts.js';
export { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE };
/** Rebuilds the Session-shared Background reminder cadence from canonical History. */
export function projectBackgroundHistory(messages) {
    const inherited = readCompactionCompatibility(messages[0])?.backgroundCadence;
    let state = inherited
        ? { ...inherited, hasBackgroundState: true }
        : {
            assistantIterationsSinceReminder: TODO_CADENCE_INTERVAL,
            observedTerminalCount: 0,
            hasBackgroundState: false,
        };
    for (const message of messages) {
        if (message.role === 'assistant') {
            state = {
                ...state,
                assistantIterationsSinceReminder: advanceAssistantIterationCadence(state.assistantIterationsSinceReminder),
            };
        }
        const observation = readReminderObservation(message);
        if (observation) {
            const observedTerminalCount = resolveObservedTerminalCount(state, observation);
            state = {
                assistantIterationsSinceReminder: 0,
                ...(observedTerminalCount === undefined ? {} : { observedTerminalCount }),
                hasBackgroundState: true,
            };
        }
        else if (isBackgroundTaskReadSettlement(message)) {
            state = { ...state, assistantIterationsSinceReminder: 0, hasBackgroundState: true };
        }
    }
    return state;
}
function resolveObservedTerminalCount(state, observation) {
    if (observation.observedTerminalCount === undefined) {
        return state.hasBackgroundState ? state.observedTerminalCount : undefined;
    }
    return Math.max(state.observedTerminalCount ?? 0, observation.observedTerminalCount);
}
function readReminderObservation(message) {
    if (message.role === 'custom' &&
        Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
        Reflect.get(message, 'display') === false) {
        const details = readRecord(Reflect.get(message, 'details'));
        const observedTerminalCount = nonNegativeSafeInteger(details.terminalTotal);
        return observedTerminalCount === undefined ? undefined : { observedTerminalCount };
    }
    if (message.role !== 'user')
        return undefined;
    const origin = readBackgroundTaskOriginMetadata(message);
    if (!origin)
        return undefined;
    return origin.observedTerminalCount === undefined
        ? {}
        : { observedTerminalCount: origin.observedTerminalCount };
}
function nonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=background-cadence.js.map