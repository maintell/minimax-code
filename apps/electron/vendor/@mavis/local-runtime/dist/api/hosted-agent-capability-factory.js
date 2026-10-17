import { createHostedAgentCapabilities, } from './hosted-agent-capabilities.js';
/**
 * Embedded command-line owners run a v2 Runtime without a Scheduler, so Cron,
 * memory are unavailable there. This is the single source of truth for
 * "this host is a restricted command-line runtime" — reused by the reminder
 * pipeline so prompt guidance cannot drift from the capability matrix.
 */
export function isCliRestrictedRuntime(runtimeOwnerKind, cliEmbedded) {
    return (runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui') && cliEmbedded === true;
}
export function createHostedCapabilities(host, runtimeOwnerKind, cliEmbedded, capabilityProfile) {
    const cliRuntime = isCliRestrictedRuntime(runtimeOwnerKind, cliEmbedded);
    return createHostedAgentCapabilities(host, cliRuntime
        ? {
            disableMemory: true,
            disableCron: true,
            ...(capabilityProfile === 'cli'
                ? {
                    disableMavis: true,
                    disabledBuiltinSkillNames: ['mavis-doctor', 'plugin-creator'],
                    resumeCodexAvailable: true,
                }
                : {}),
        }
        : undefined);
}
//# sourceMappingURL=hosted-agent-capability-factory.js.map