import { buildPluginSkillRuntimeName } from '@mavis/shared';
const PPT_PREVIEW_PLUGIN_NAME = 'ppt';
const PPT_PREVIEW_SKILL_RUNTIME_NAME = buildPluginSkillRuntimeName(PPT_PREVIEW_PLUGIN_NAME, 'ppt-preview');
/**
 * The model-facing PPT preview entry is distributed by the PPT Plugin. It is admitted only when
 * this Turn's effective Plugin Skills (enabled Plugin, Agent selection applied) contain the
 * `ppt:ppt-preview` Skill; any other state contributes neither the tool nor its prompt.
 */
export function isPptPreviewPluginSkillEffective(ctx) {
    const skills = ctx.agentConfig.desktopPluginSkills;
    if (!Array.isArray(skills))
        return false;
    return skills.some((entry) => {
        if (!entry || typeof entry !== 'object')
            return false;
        const pluginName = Reflect.get(entry, 'pluginName');
        const name = Reflect.get(entry, 'name');
        return (typeof pluginName === 'string' &&
            typeof name === 'string' &&
            normalizedName(pluginName) === PPT_PREVIEW_PLUGIN_NAME &&
            normalizedName(name) === PPT_PREVIEW_SKILL_RUNTIME_NAME);
    });
}
function normalizedName(value) {
    return value.trim().normalize('NFKC').toLowerCase();
}
//# sourceMappingURL=ppt-preview-plugin-gate.js.map