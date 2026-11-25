import { pluginAgentPackageGrantSource, pluginSkillGrantSource, } from './session-readable-grants.js';
/**
 * Plugin files the runtime hands the Agent from a Session's running Turns,
 * read-only: the Skill directories and the package of the Plugin Agent the
 * Session runs. See `pluginSkillGrantSource` and
 * `pluginAgentPackageGrantSource`. A host without Turn capabilities grants none.
 */
export function pluginReadGrantSources(turnCapabilities, definitions) {
    if (!turnCapabilities)
        return [];
    const views = (sessionId) => turnCapabilities.capturedCapabilities(sessionId);
    return [
        pluginSkillGrantSource({
            capturedSkills: (sessionId) => views(sessionId).flatMap((view) => view.skills),
        }),
        pluginAgentPackageGrantSource({
            capturedAgents: (sessionId) => views(sessionId).flatMap((view) => view.agents ?? []),
            pluginAgentOf: async (sessionId) => {
                const binding = await definitions.getSessionAgentDefinition(sessionId);
                const source = binding && 'pluginSource' in binding.definition
                    ? binding.definition.pluginSource
                    : undefined;
                return source
                    ? { scopedName: source.scopedName, packageDigest: source.packageDigest }
                    : undefined;
            },
        }),
    ];
}
//# sourceMappingURL=plugin-grant-sources.js.map