import { createProcessLocalApplication } from '../index.js';
import { createProcessLocalMiniAppApplication } from './process-local-miniapp-application.js';
/**
 * Wires the process-local Application facade over owners the runtime has already
 * initialized, keeping that wiring out of the services composition root.
 */
export function composeProcessLocalApplication(input) {
    return createProcessLocalApplication({
        eventBus: input.eventBus,
        usageCommits: input.usageCommits,
        skills: {
            listSkills: (request) => input.listSkills(request),
            listRuntimeSkills: (request) => input.listRuntimeSkills(request),
        },
        plugins: input.plugins,
        miniApps: createProcessLocalMiniAppApplication(input.pluginControl, input.miniApp),
        workspace: { ...input.compatibility.peripherals.workspace },
        plan: { isEntryEnabled: input.planEntryEnabled },
        ...(input.sessionReports ? { sessionReports: input.sessionReports } : {}),
        instructions: input.instructions,
        peripherals: { ...input.compatibility.peripherals, mcp: input.mcp },
        modelProvider: input.modelProvider,
    });
}
//# sourceMappingURL=process-local-composition.js.map