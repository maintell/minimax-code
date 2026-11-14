import { withCoordinatorCronSpace } from '../cron/tool-defs.js';
import { LocalMavisCoordinatorToolDef, LocalMavisToolDef } from './builtin-defs.js';
/**
 * The definition a trusted coordinator (Bunny) sees for one of its tools: mavis
 * with the space and project commands, cron_create with `space`. Every other
 * tool keeps its definition, and every other Agent never sees these variants.
 */
export function coordinatorToolDefinition(def) {
    if (def.name === LocalMavisToolDef.name)
        return {
            ...def,
            description: LocalMavisCoordinatorToolDef.description,
            schema: LocalMavisCoordinatorToolDef.schema,
            operationClassifier: LocalMavisCoordinatorToolDef.operationClassifier,
        };
    return withCoordinatorCronSpace(def);
}
//# sourceMappingURL=local-mavis-coordinator.js.map