export const SAFETY_SCENE = {
    MessageOutput: 1,
    StreamChunk: 2,
    ThinkingContent: 3,
    ConfigField: 205,
    // Semantic intents; transport maps these to independent V2 wire codes.
    AgentConfigName: 'agent-config-name',
    AgentConfigAvatar: 'agent-config-avatar',
    CronTitle: 'cron-title',
    UserInput: 300,
};
export function reviewBlocks(result) {
    return !result.pass && result.errorKind !== 'api_error';
}
export function createDeferredContentSafetyCapability() {
    let current;
    const requireOwner = () => {
        if (!current)
            throw new Error('Content safety owner is not initialized');
        return current;
    };
    return {
        capability: {
            review: async (...args) => {
                if (!current)
                    return { pass: false, errorKind: 'local_error' };
                return current.review(...args);
            },
            reviewText: async (input) => current ? current.reviewText(input) : { pass: false, errorKind: 'local_error' },
            reviewV2: async (input) => requireOwner().reviewV2(input),
        },
        bind: (owner) => {
            if (current)
                throw new Error('Content safety owner already bound');
            current = owner;
            return () => {
                if (current === owner)
                    current = undefined;
            };
        },
    };
}
//# sourceMappingURL=local-runtime-safety.js.map