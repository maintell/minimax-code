import { createBackgroundCadenceReminder } from './background-cadence-reminder.js';
import { createMemorySummaryReminder } from './memory-summary-reminder.js';
import { createPtcScriptCatalogReminder } from './ptc-script-catalog-reminder.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';
/** Memory V2 off: no recall access, so summaries left in history are withdrawn. */
const noMemorySummary = async () => ({ status: 'disabled' });
/** No PTC script wiring: every copy leaves the request, as when Memory V2 is off. */
const noPtcScripts = async () => ({ status: 'disabled' });
/**
 * Host-owned Turn reminders that measure request budget against one usage anchor.
 *
 * Both loaders are optional: a caller with no Memory V2 or no PTC wiring can
 * leave them out, which is the same as passing `undefined` and installs the
 * withdrawing reminder below.
 */
export function createHostTurnReminders(usageAnchor, memorySummaryContext, ptcScriptCatalog, onPtcScriptCatalogInjected) {
    return {
        backgroundCadenceReminder: createBackgroundCadenceReminder(usageAnchor),
        // Installed even when Memory V2 is not assembled: Sessions that carried a
        // summary before must stop sending it, as when it lived in the system prompt.
        memorySummaryReminder: createMemorySummaryReminder(memorySummaryContext ?? noMemorySummary, usageAnchor),
        // Installed unconditionally for the same reason: a Session that had the
        // catalog must stop sending it once its scripts are gone or PTC is off.
        ptcScriptCatalogReminder: createPtcScriptCatalogReminder(ptcScriptCatalog ?? noPtcScripts, usageAnchor, onPtcScriptCatalogInjected),
        canAppendExecutionBudgetReminder: (input, marker) => fitsReminderInFinalRequest(input, marker, usageAnchor),
    };
}
//# sourceMappingURL=host-turn-reminders.js.map