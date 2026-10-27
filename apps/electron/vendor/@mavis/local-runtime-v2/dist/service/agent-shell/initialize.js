import { AgentShellService } from './agent-shell.service.js';
import { createWindowsShellDetector } from './windows-shell-detector.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';
export function bindAgentShellService(service, ports) {
    service.bindSessions({
        get: ports.sessions,
        save: (id, shell) => ports.records.mutateSession(id, { agentShell: shell }),
    });
    ports.records.bindAgentShellCapture((parent) => service.captureNew(parent));
    ports.preparation.bindAgentShellResolver((id) => service.resolveSession(id));
    ports.bindPermissions?.(async (id) => {
        const shell = await service.ensureSession(id);
        if (!shell)
            return undefined;
        return shell.family === 'git-bash' ? 'posix' : 'powershell';
    });
    service.warmup();
}
export function initializeAgentShellService(options) {
    return new AgentShellService({
        ...options,
        preferences: {
            get: async (key) => readPreferenceValue(options.db, key),
            set: async (key, value) => upsertPreferenceValue(options.db, key, value),
        },
        platform: process.platform,
        detector: createWindowsShellDetector(),
    });
}
//# sourceMappingURL=initialize.js.map