import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { isCoordinatorHiddenToolName } from '../shared/builtin-tool-namespaces.js';
import { coordinatorHiddenToolRefusal } from './local-coordinator-tool-refusal.js';
/**
 * The executor half of the coordinator allowlist (`isCoordinatorHiddenToolName`).
 *
 * The catalog already keeps every namespaced tool outside the allowlist away
 * from a trusted coordinator, so a call should never get here. This guard is
 * what still holds when it does — a catalog change, a new route, a tool moved
 * to another executor: the call is refused before it reaches any adapter, for
 * every such tool at once rather than in each tool's own code. A tool the
 * coordinator may call, and every call by any other Agent, runs unchanged.
 *
 * `buildLocalToolRegistry` installs it on every tool it registers; the
 * definition object is kept, so everything keyed by it (the mavis-backed
 * target, the Skill gate) still finds the tool.
 */
export function withCoordinatorToolGuard(tool) {
    const name = tool.def.name;
    if (!isCoordinatorHiddenToolName(name))
        return tool;
    return {
        ...tool,
        impl: {
            execute: async (ctx, input, signal, onUpdate) => isCoordinatorAgent(ctx.coordination)
                ? coordinatorHiddenToolRefusal(name)
                : tool.impl.execute(ctx, input, signal, onUpdate),
        },
    };
}
//# sourceMappingURL=local-coordinator-tool-guard.js.map