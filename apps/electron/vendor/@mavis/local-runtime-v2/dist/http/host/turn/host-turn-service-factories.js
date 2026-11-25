import { join } from 'node:path';
import { AuthStorage } from '@earendil-works/pi-coding-agent/auth-storage';
import { LocalModelResolver, } from '../../../service/model-system/index.js';
import { LocalGreetingSystemReminderSender } from '../host-greeting-sender.js';
import { LocalHookService } from '../../../service/hook/index.js';
/** Host 的 Hook 服务：测试注入的实例，或产品内置的处理器。 */
export function createHostHookService(options) {
    return (options.hookService ??
        new LocalHookService({
            ...(options.mergeRequests ? { mergeRequests: options.mergeRequests } : {}),
            ...(options.metricsReporter ? { metricsReporter: options.metricsReporter } : {}),
        }));
}
export function createLocalModelResolver(input) {
    return new LocalModelResolver({
        providerConfigGetter: () => input.configGetter().provider,
        byokConfigGetter: () => {
            const { minimax_api, custom_provider, minimaxModelSource } = input.configGetter();
            return { minimax_api, custom_provider, minimaxModelSource };
        },
        authContextGetter: input.authContextGetter,
        routingContextGetter: input.routingContextGetter,
        providerAuthGetter: (provider) => {
            const authStorage = AuthStorage.create(join(input.configGetter().dataDir, 'codex-auth.json'));
            return authStorage.getApiKey(provider, { includeFallback: false, fetch: input.fetchImpl });
        },
        fetchImpl: input.fetchImpl,
    });
}
/** Build the `LocalGreetingSystemReminderSender` from host closures. */
export function createLocalGreetingSystemReminderSender(host, runtimeConversation) {
    return new LocalGreetingSystemReminderSender({
        getSessionById: (sessionId) => host.getSessionById(sessionId),
        submitConversationTurn: ({ sessionId, content, requestedTurnId }) => {
            if (!runtimeConversation) {
                throw new Error('Runtime Conversation is unavailable for greeting delivery');
            }
            return runtimeConversation.ingress.submit({
                sessionId,
                source: 'greeting',
                allowQueue: true,
                requestedTurnId,
                message: { content, attachments: [], hideUserMessage: true },
            });
        },
    });
}
//# sourceMappingURL=host-turn-service-factories.js.map