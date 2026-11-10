import { callbackify } from 'node:util';
import { logger } from '../../../infra/logging/logger.js';
import { LocalQuestionnaireService, } from '../orchestration/service.js';
export function startQuestionnaireRecovery(host, channelRestoreReady) {
    callbackify(recoverQuestionnaireOnStartup)(host, channelRestoreReady, (error) => {
        // Recovery reports its own failures as bus events; this only catches a failing reporter.
        if (error)
            logger.warn({ error }, 'Questionnaire startup recovery could not report its outcome');
    });
}
async function recoverQuestionnaireOnStartup(host, channelRestoreReady) {
    try {
        await (channelRestoreReady ?? Promise.resolve());
        const stats = await new LocalQuestionnaireService(host.questionnaireServiceDeps()).recoverOnStartup();
        if (stats.expired > 0 || stats.reinjected > 0 || stats.reemitted > 0) {
            host.emitBusEvent('questionnaire.recovery', { ...stats });
        }
    }
    catch (err) {
        host.emitBusEvent('questionnaire.recovery_failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
//# sourceMappingURL=recovery.js.map