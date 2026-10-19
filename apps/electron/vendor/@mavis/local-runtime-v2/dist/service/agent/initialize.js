import { DrizzleAgentRepository } from './storage/agent.repository.js';
import { LocalAgentService, } from './application/agent.service.js';
import { LocalPromptFileReader } from '../prompt-config/index.js';
export function createAgentRuntimeOwner(input) {
    const promptFileReader = new LocalPromptFileReader();
    const repository = new DrizzleAgentRepository({
        db: input.database,
        dataDir: input.dataDir,
        facts: input.facts,
    });
    const service = new LocalAgentService({
        repository,
        promptFileReader,
        ...(input.promptMode
            ? { promptMode: input.promptMode, promptVersion: input.promptVersion }
            : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(input.facts ? { facts: input.facts } : {}),
        ...(input.reportIdentityDetach ? { reportIdentityDetach: input.reportIdentityDetach } : {}),
        ...(input.reportLegacyCustomMaterialization
            ? { reportLegacyCustomMaterialization: input.reportLegacyCustomMaterialization }
            : {}),
    });
    let closed = false;
    return {
        service,
        promptFileReader,
        close: () => {
            if (closed)
                return;
            closed = true;
            service.close();
        },
    };
}
//# sourceMappingURL=initialize.js.map