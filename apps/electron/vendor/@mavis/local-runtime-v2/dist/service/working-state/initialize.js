import { WorkingStateService } from './working-state.service.js';
import { createWorkingStateTool } from './working-state.tool.js';
/**
 * Bunny's working-state ledger and its front tool. The tool is offered only to the Bunny
 * Agent and checks on every call that it runs in Bunny's active main conversation.
 */
export function initializeWorkingState(options) {
    const { agentName, ...serviceOptions } = options;
    const service = new WorkingStateService(serviceOptions);
    return {
        service,
        tools: (source, input) => (input.agentName === agentName ? [createWorkingStateTool(service, source, input)] : []),
    };
}
//# sourceMappingURL=initialize.js.map