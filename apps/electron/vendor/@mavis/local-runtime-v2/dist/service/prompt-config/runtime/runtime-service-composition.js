import { bindRuntimePromptSupport, createRuntimePromptLifecycle, } from './runtime-prompt-config.js';
export function bindRuntimeServicePromptLifecycle(input) {
    bindRuntimePromptSupport(input.compatibility, input.support);
    return createRuntimePromptLifecycle({
        promptConfig: input.support.promptConfig,
        lifecycle: input.lifecycle,
        bindings: input.compatibility,
        internalTurnPromptReads: input.support.internalTurnPromptReads,
    });
}
export function createRuntimePromptAuthNotifier(notifyPlugin, promptConfig) {
    return async (authState) => {
        const pluginChange = notifyPlugin(authState);
        promptConfig?.notifyAuthContextChanged();
        await pluginChange;
    };
}
//# sourceMappingURL=runtime-service-composition.js.map