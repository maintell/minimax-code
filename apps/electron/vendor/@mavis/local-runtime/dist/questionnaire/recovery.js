import { LocalQuestionnaireService } from './service.js';
export function startQuestionnaireRecovery(host, channelRestoreReady) {
    void (channelRestoreReady ?? Promise.resolve())
        .then(() => new LocalQuestionnaireService(host.questionnaireServiceDeps()).recoverOnStartup())
        .then((stats) => {
        if (stats.expired > 0 || stats.reinjected > 0 || stats.reemitted > 0) {
            host.emitBusEvent('questionnaire.recovery', { ...stats });
        }
    })
        .catch((err) => {
        host.emitBusEvent('questionnaire.recovery_failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
}
//# sourceMappingURL=recovery.js.map