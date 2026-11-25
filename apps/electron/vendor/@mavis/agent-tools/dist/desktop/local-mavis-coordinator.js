import { withCoordinatorCronSpace } from '../cron/tool-defs.js';
import { LOCAL_TASK_COORDINATOR_TOOL_DESCRIPTION } from './builtin-defs.js';
/**
 * The definition a trusted coordinator (Bunny) sees for one of its tools:
 * cron_create with `space`, and `task` whose two session-dispatch pointers name
 * the assignment tools it actually has. Every other tool keeps its definition,
 * and every other Agent never sees these variants.
 */
export function coordinatorToolDefinition(def) {
    if (def.name === 'task')
        return { ...def, description: LOCAL_TASK_COORDINATOR_TOOL_DESCRIPTION };
    return withCoordinatorCronSpace(def);
}
//# sourceMappingURL=local-mavis-coordinator.js.map