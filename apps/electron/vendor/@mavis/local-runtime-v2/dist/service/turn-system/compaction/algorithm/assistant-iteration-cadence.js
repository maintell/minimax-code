import { TODO_CADENCE_INTERVAL } from '../compat.js';
export function advanceAssistantIterationCadence(value) {
    return Math.min(TODO_CADENCE_INTERVAL, value + 1);
}
//# sourceMappingURL=assistant-iteration-cadence.js.map