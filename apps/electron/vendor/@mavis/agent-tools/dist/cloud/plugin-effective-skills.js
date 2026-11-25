import { buildPluginSkillRuntimeName } from '@mavis/shared';
/**
 * Build the immutable Skill view for one turn. Hosted refs keep their inbound
 * order and win conflicts; Plugin Skills are considered in stable official
 * package/name order. The global package index is never mutated by conflicts.
 *
 * v1 cloud-runtime 与 v2 cloud-harness-server 共用（v1 原路径 re-export）。
 */
export function buildEffectiveSkillView(hostedSkills, pluginSkills) {
    const skills = [];
    const selections = new Map();
    const diagnostics = [];
    for (const hosted of hostedSkills) {
        const key = skillNameKey(hosted.name);
        if (selections.has(key))
            continue;
        skills.push(hosted);
        selections.set(key, { source: 'hosted', name: hosted.name });
    }
    const orderedPlugins = [...pluginSkills].sort((left, right) => left.pluginName.localeCompare(right.pluginName) ||
        left.pluginVersion.localeCompare(right.pluginVersion) ||
        left.name.localeCompare(right.name) ||
        left.key.localeCompare(right.key));
    for (const pluginSkill of orderedPlugins) {
        const runtimeName = buildPluginSkillRuntimeName(pluginSkill.pluginName, pluginSkill.name);
        const key = skillNameKey(runtimeName);
        const winner = selections.get(key);
        if (winner) {
            diagnostics.push({
                code: 'PLUGIN_SKILL_NAME_CONFLICT',
                pluginName: pluginSkill.pluginName,
                skillName: pluginSkill.name,
                winner: winner.source === 'hosted' ? 'hosted' : `plugin:${winner.pluginName}`,
            });
            continue;
        }
        skills.push({
            name: runtimeName,
            description: pluginSkill.description,
            mutable: false,
            global: false,
        });
        selections.set(key, {
            source: 'plugin',
            pluginName: pluginSkill.pluginName,
            name: runtimeName,
            content: pluginSkill.content,
            location: pluginSkill.skillRoot,
        });
    }
    return {
        skills,
        diagnostics,
        lookup: (name) => selections.get(skillNameKey(name)),
    };
}
function skillNameKey(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
//# sourceMappingURL=plugin-effective-skills.js.map