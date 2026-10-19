/**
 * Agent runtime selection config — pure type-level module.
 *
 * Defines the local runtime knob for freshly-created sessions. New local
 * sessions run through Pi, while any stale session metadata is handled as
 * archive-only by the local host.
 *
 * Intentionally has **zero** Node-only imports so this file can be consumed
 * unchanged across the workspace. Config sits beneath the local/cloud runtime
 * packages in the dependency graph, so keep this module as plain data parsing.
 *
 * Keep this module Node-free so Electron, CLI, and local runtime can share it.
 */
/** All recognised config framework strings. Used by `parseAgentRuntimeFramework`. */
export const AGENT_RUNTIME_FRAMEWORKS = ['pi-agent'];
/**
 * Default runtime used when `config.yaml` omits `agentRuntime` or sets an
 * unrecognised value.
 */
export const DEFAULT_AGENT_RUNTIME_FRAMEWORK = 'pi-agent';
/**
 * Coerce an unknown raw value (typically a string from `config.yaml`) into
 * an {@link AgentRuntimeFramework}. Returns
 * {@link DEFAULT_AGENT_RUNTIME_FRAMEWORK} for anything that is not one of
 * {@link AGENT_RUNTIME_FRAMEWORKS}.
 *
 * A typo (`'pi'` instead of `'pi-agent'`) falls back to Pi instead of creating
 * another runtime mode.
 */
export function parseAgentRuntimeFramework(raw) {
    if (typeof raw !== 'string')
        return DEFAULT_AGENT_RUNTIME_FRAMEWORK;
    if (AGENT_RUNTIME_FRAMEWORKS.includes(raw)) {
        return raw;
    }
    return DEFAULT_AGENT_RUNTIME_FRAMEWORK;
}
/**
 * Parse the `agentRuntime` section of a raw `config.yaml`. Always returns a
 * fully-populated config — missing / malformed fields fall back to defaults.
 */
export function parseAgentRuntimeConfig(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { defaultFramework: DEFAULT_AGENT_RUNTIME_FRAMEWORK };
    }
    const obj = raw;
    return {
        defaultFramework: parseAgentRuntimeFramework(obj.defaultFramework),
    };
}
//# sourceMappingURL=agent-runtime-config.js.map