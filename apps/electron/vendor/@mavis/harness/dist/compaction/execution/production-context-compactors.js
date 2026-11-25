import { isValidCompactionTriggerSetting } from '@mavis/context-manager';
import { AutomaticContextCompactor } from '../automatic-context-compactor.js';
import { LocalContextCompactor } from '../local-context-compactor.js';
/** Builds the automatic and manual context compactors of one run. */
export function createContextCompactors(input) {
    return {
        automatic: new AutomaticContextCompactor(input.contextUsageAnchor, input.checkpointState, input.logger, {
            checkpointRequestMessages: input.checkpointRequestMessages,
            mainRequestMessages: input.mainRequestMessages,
            checkpointReminder: input.checkpointReminder,
            imageFileWriter: input.imageFileWriter,
            promptSnapshots: input.promptSnapshots,
            resolveEarlierFiles: input.resolveEarlierFiles,
            getCompactionTriggerAt: input.getCompactionTriggerAt,
        }),
        manual: new LocalContextCompactor(input.checkpointState, input.logger, input.promptSnapshots, {
            imageFileWriter: input.imageFileWriter,
            resolveEarlierFiles: input.resolveEarlierFiles,
            reminder: input.checkpointReminder,
            projectRequestMessages: input.checkpointRequestMessages,
            mainRequestMessages: input.mainRequestMessages,
        }),
    };
}
/**
 * Reads `contextManagement.compactionTriggerAt` per call. An invalid value is
 * reported once when the getter is created and then ignored by the budget.
 */
export function createCompactionTriggerAtGetter(read, logger) {
    try {
        const initial = read();
        if (initial !== undefined && !isValidCompactionTriggerSetting(initial)) {
            logger?.warn?.({ event: 'context_compaction_trigger_config_ignored', value: initial }, '[local-runtime-v2] contextManagement.compactionTriggerAt must be a ratio in (0, 1] or an integer token count above 1; using the built-in trigger');
        }
    }
    catch {
        // The compactor treats an unreadable config as unset.
    }
    return read;
}
//# sourceMappingURL=production-context-compactors.js.map