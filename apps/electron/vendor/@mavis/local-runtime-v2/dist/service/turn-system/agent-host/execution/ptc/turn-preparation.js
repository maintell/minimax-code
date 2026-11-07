import { createPtcToolFactCollector, } from '@mavis/agent-core/tools';
import { applyProcessLocalToolResultPolicy } from '../../runner/policy/process-local-tool-result-policy.js';
import { observePtcAdmission } from '../../runner/policy/ptc-admission-observability.js';
import { createPtcToolLabeler, createPtcTurnObserver } from '../../runner/ptc/ptc-observability.js';
import { isNativeTaskOutputTool, readPtcChildTools, readPtcNativeCatalog, readPtcTurnReminder, } from './catalog.js';
import { createPtcCompactionReminderRestorer, } from './compaction-reminder.js';
/** The PTC reminder restorer for a Turn; undefined when the Turn has no PTC reminder. */
export function createPtcTurnCompactionReminder(input, options) {
    return createPtcCompactionReminderRestorer(readPtcReminderForRestore(input, options.logger), 
    // Production binds this to fitsReminderInFinalRequest, a generic
    // "does this marker still fit the final request" check.
    options.canAppendExecutionBudgetReminder, options.logger);
}
/**
 * buildPtcCatalog registers the reminder on the run_code it creates, and the
 * executor's own PTC wiring (readPtcChildTools) already relies on that object
 * reaching `assembly.tools` unchanged. A PTC Turn without a registered reminder
 * means that chain broke somewhere; say so instead of silently skipping the
 * restore.
 */
function readPtcReminderForRestore(input, logger) {
    const reminder = readPtcTurnReminder(input.assembly.tools);
    if (reminder === undefined && readPtcChildTools(input.assembly.tools) !== undefined) {
        try {
            logger?.warn?.({ session_id: input.lease.sessionId, turn_id: input.lease.turnId }, 'ptc reminder unavailable for compaction restore');
        }
        catch {
            // Diagnostics must not affect the Turn.
        }
    }
    return reminder;
}
export function preparePtcExecution(tools, nativeTools, options, input) {
    const rawPtcTools = readPtcChildTools(tools);
    const ptcTools = rawPtcTools
        ? applyProcessLocalToolResultPolicy(rawPtcTools, options.cliProductPolicy === true)
        : undefined;
    const ptcFactCollector = createPtcToolFactCollector();
    const ptcResultProjection = options.createPtcResultProjection?.(ptcFactCollector);
    // Only PTC Turns get an observer, so only they report program-level metrics.
    const ptcObserver = ptcTools ? createTurnObserver(input, options) : undefined;
    return {
        ptcTools,
        canConsumeNativeTaskOutput: (ptcTools ?? nativeTools).some(isNativeTaskOutputTool),
        ptcFactCollector,
        context: {
            ptcFactCollector,
            ...(ptcResultProjection ? { ptcResultProjection } : {}),
            // Only PTC turns get the logger: run_code and direct calls of its children use it.
            ...(ptcTools && options.logger ? { ptcLogger: options.logger } : {}),
            ...(ptcObserver ? { ptcObserver } : {}),
        },
    };
}
/**
 * Records the catalog's decision for a PTC-mode Session Turn once the request
 * prefix is final (system prompt and tools exactly as sent), so the admission
 * line can carry the prefix fingerprint. The native catalog is buildPtcCatalog's
 * input on a PTC Turn and the assembled catalog itself otherwise.
 */
export function observePtcTurnAdmission(input, ptc, options, prefix) {
    observePtcAdmission(input, ptc.ptcTools !== undefined, options, {
        ...prefix,
        nativeCatalog: readPtcNativeCatalog(input.assembly.tools) ?? input.assembly.tools,
    });
}
function createTurnObserver(input, options) {
    return createPtcTurnObserver({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
        ...(options.ptcSurface ? { surface: options.ptcSurface } : {}),
        labelTool: createPtcToolLabeler(input.desktopCapabilities?.runtimeToolBindings),
    });
}
//# sourceMappingURL=turn-preparation.js.map