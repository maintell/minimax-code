/**
 * Build the model-facing identity for a Skill contributed by a Plugin.
 *
 * Package metadata and filesystem paths keep using the original Skill name.
 * This qualified name exists only at the runtime projection boundary so
 * Plugin Skills do not collide with standalone Skills or Skills from another
 * Plugin.
 */
export function buildPluginSkillRuntimeName(pluginName, skillName) {
    return `${pluginName.trim()}:${skillName.trim()}`;
}
//# sourceMappingURL=plugin-skill-name.js.map