import { join } from 'node:path';
import { AuthStorage } from '@earendil-works/pi-coding-agent/auth-storage';
import { LocalModelResolver, } from '../../../service/model-system/index.js';
import { LocalGreetingSystemReminderSender } from '../host-greeting-sender.js';
import { LocalHookService } from '../../../service/hook/index.js';
/** Host 的模型、Hook 与 greeting 绑定共享同一 profile 和 Session 查询能力。 */
export function createHostHookService(input) {
    return (input.options.hookService ??
        new LocalHookService({
            dataDir: input.dataDir,
            nowMs: input.nowMs,
            resolveWorkspaceDir: input.resolveWorkspaceDir,
            resolveSessionWorkspaceDir: async (sessionId) => {
                try {
                    const session = await input.getSessionById(sessionId);
                    return session?.runLocation?.resolvedDir ?? session?.workspaceDir;
                }
                catch {
                    // 查询失败时跳过记录，避免将分支 Session 的记录归到 Host 默认目录。
                    return undefined;
                }
            },
            ...(input.options.metricsReporter ? { metricsReporter: input.options.metricsReporter } : {}),
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