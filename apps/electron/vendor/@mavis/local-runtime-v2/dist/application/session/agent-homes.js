import path from 'node:path';
import { keepsPrivateHomeDir } from '@mavis/shared/agent-coordination';
/**
 * The home the runtime keeps for an Agent inside its private data directory:
 * a coordinator declaring `homeDir: private` owns `<dataDir>/<Agent name>`
 * (Bunny's worklines, memory and notes). The Agent reads it without asking,
 * both in its own Turns and in the permission check route, so the two agree.
 */
export function agentHomeDirectories(roster, dataDir, agentName) {
    return keepsPrivateHomeDir(roster.coordinationOf(agentName))
        ? [path.join(dataDir, agentName)]
        : [];
}
//# sourceMappingURL=agent-homes.js.map