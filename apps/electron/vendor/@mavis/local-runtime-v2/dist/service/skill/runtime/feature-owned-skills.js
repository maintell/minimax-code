import { AGENT_BUILTIN_SKILL_IDS } from '@mavis/config';
function isAgentBuiltinToolEnabled(capabilities, name) {
    return capabilities.tools === undefined || capabilities.tools.includes(name);
}
export function resolveFeatureAwareBuiltinSkillNames(capabilities, gates) {
    const configuredSkills = capabilities.skills ?? AGENT_BUILTIN_SKILL_IDS;
    const selected = new Set(configuredSkills.filter((skillName) => isStandaloneSkillUsable(skillName, capabilities)));
    addFeatureSkills(selected, capabilities, gates);
    addRuntimeSkills(selected, capabilities, gates);
    for (const skillName of gates.disabledSkillNames ?? [])
        selected.delete(skillName);
    return [...selected];
}
const STANDALONE_TOOL_REQUIREMENTS = {
    'code-review': ['read'],
    'deploy-website': ['read', 'write', 'bash', 'website_deploy'],
    'edit-deployed-website': ['read', 'edit', 'bash', 'website_deploy'],
    docx: ['read', 'write', 'bash'],
    pdf: ['read', 'write', 'bash'],
    pptx: ['read', 'write', 'bash'],
    xlsx: ['read', 'write', 'bash'],
    init: ['read', 'write', 'bash'],
    'plugin-creator': ['read', 'write', 'bash'],
    'skill-creator': ['read', 'write', 'bash'],
    'lark-tools': ['bash'],
    'llm-call': ['bash'],
    'mcode-tools-master': ['bash'],
    'mavis-doctor': ['bash'],
    'skill-refiner': ['read', 'edit'],
    'visual-page': ['write'],
    'x-link-reader': ['web_fetch'],
};
function isStandaloneSkillUsable(skillName, capabilities) {
    if (skillName === 'deep-research') {
        return (hasTools(capabilities, ['read', 'write', 'todowrite']) &&
            (capabilities.features.webSearch ||
                isAgentBuiltinToolEnabled(capabilities, 'web_fetch') ||
                isAgentBuiltinToolEnabled(capabilities, 'bash')));
    }
    const required = STANDALONE_TOOL_REQUIREMENTS[skillName];
    return required !== undefined && hasTools(capabilities, required);
}
function addFeatureSkills(selected, capabilities, gates) {
    if (capabilities.features.mavis) {
        selected.add('mavis');
        selected.add('create-agent');
        selected.add('minimax-code-product');
    }
    if (gates.miniappAvailable === true &&
        hasTools(capabilities, ['read', 'write', 'edit', 'bash'])) {
        selected.add('miniapp-creator');
    }
}
function addRuntimeSkills(selected, capabilities, gates) {
    if (gates.resumeCodexAvailable === true && isAgentBuiltinToolEnabled(capabilities, 'bash')) {
        selected.add('resume-codex');
    }
}
function hasTools(capabilities, toolNames) {
    return toolNames.every((toolName) => isAgentBuiltinToolEnabled(capabilities, toolName));
}
//# sourceMappingURL=feature-owned-skills.js.map