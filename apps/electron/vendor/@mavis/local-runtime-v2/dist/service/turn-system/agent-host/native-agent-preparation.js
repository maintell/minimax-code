import { getLocalBashEnvironment } from '@mavis/agent-tools';
import { LocalAgentConfigBuilder, LocalAgentPreparationService, } from './preparation/index.js';
/** Builds the shared native config/model preparation used by AgentHost and title calls. */
export function createNativeLocalAgentPreparation(options) {
    // The prompt keeps the first answer of its process: every Turn of this
    // preparation composes the same `# Environment` block, so the system prompt
    // prefix stays byte-identical and a machine change mid-Session cannot shift it.
    let environment;
    return new LocalAgentPreparationService({
        configBuilder: new LocalAgentConfigBuilder({
            ...options.configBuilder,
            environment: options.configBuilder.environment ??
                (() => {
                    environment ??= getLocalBashEnvironment();
                    return environment;
                }),
        }),
        modelResolver: options.modelResolver,
    });
}
//# sourceMappingURL=native-agent-preparation.js.map