import { createRuntimePromptAuthNotifier } from '../../service/prompt-config/index.js';
import { describeError } from './turn-message-delivery.js';
/** Resume durable work only after Desktop has synchronized memory-only auth. */
export function createRuntimeAuthRecoveryNotifier(input) {
    const notifyContextChanged = createRuntimePromptAuthNotifier(input.notifyPluginContextChanged, input.promptConfig);
    return async (authState) => {
        await notifyContextChanged(authState);
        if (input.mode !== 'desktop' || authState !== 'authenticated' || input.isClosed())
            return;
        try {
            await input.recoverQuestionnaires();
        }
        catch (error) {
            input.reportFailure?.('auth-questionnaire-recovery', describeError(error));
        }
        input.reconcilePlan();
        try {
            for (const sessionId of await input.listPendingSessionIds()) {
                if (input.isClosed())
                    break;
                try {
                    await input.dispatchQueue(sessionId);
                }
                catch (error) {
                    input.reportFailure?.('auth-queue-recovery', describeError(error));
                }
            }
        }
        catch (error) {
            input.reportFailure?.('auth-queue-recovery', describeError(error));
        }
    };
}
/** Keep durable replies and queued work unconsumed while Desktop memory auth is absent. */
export function createRuntimeAuthSubmissionPreparation(mode, getAuthContext) {
    if (mode !== 'desktop')
        return undefined;
    return {
        prepare: async () => {
            const auth = getAuthContext?.();
            if (auth?.accessToken?.trim() && auth.realUserID?.trim())
                return undefined;
            return {
                status: 'rejected',
                reason: 'policy:runtime:auth-pending',
                queueDisposition: 'defer',
            };
        },
    };
}
//# sourceMappingURL=runtime-execution-auth.js.map