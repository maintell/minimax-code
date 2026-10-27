import { HookConfigService } from './hook-config.service.js';
import { ProjectHookEnablementRepository } from './project-hook-enablement.repository.js';
import { ConfigHookSource } from './turn-hook-source.js';
export function initializeHookConfigService(options) {
    const enablement = new ProjectHookEnablementRepository(options.dataDir, options.nowMs ?? Date.now, options.logger);
    const source = new ConfigHookSource(options.dataDir, enablement, options.logger);
    return {
        management: new HookConfigService(options, source, enablement),
        turnHooks: source,
    };
}
//# sourceMappingURL=initialize.js.map