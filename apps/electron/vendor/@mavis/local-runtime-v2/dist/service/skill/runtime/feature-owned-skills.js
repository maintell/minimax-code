import { availableBuiltinToolNamespaces, coordinatorHiddenNamespaces, skillForNamespace, } from '@mavis/agent-tools';
import { AGENT_BUILTIN_SKILL_IDS } from '@mavis/config';
function isAgentBuiltinToolEnabled(capabilities, name) {
    return capabilities.tools === undefined || capabilities.tools.includes(name);
}
export function resolveFeatureAwareBuiltinSkillNames(capabilities, gates) {
    const configuredSkills = capabilities.skills ?? AGENT_BUILTIN_SKILL_IDS;
    const selected = new Set(configuredSkills.filter((skillName) => isStandaloneSkillUsable(skillName, capabilities)));
    addFeatureSkills(selected, capabilities, gates);
    addNamespaceSkills(selected, capabilities, gates);
    addRuntimeSkills(selected, capabilities, gates);
    for (const skillName of gates.disabledSkillNames ?? [])
        selected.delete(skillName);
    return [...selected];
}
const STANDALONE_TOOL_REQUIREMENTS = {
    'code-review': ['read'],
    'deploy-website': ['read', 'write', 'bash', 'website_deploy'],
    'edit-deployed-website': ['read', 'edit', 'bash', 'website_deploy'],
    init: ['read', 'write', 'bash'],
    'plugin-creator': ['read', 'write', 'bash'],
    'skill-creator': ['read', 'write', 'bash'],
    'lark-tools': ['bash'],
    'llm-call': ['bash'],
    'mcode-tools-master': ['bash'],
    'mavis-doctor': ['bash'],
    'skill-refiner': ['read', 'edit'],
    // The space_* tools are on demand and always registered; the Skill needs no built-in tool.
    space: [],
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
    // Product knowledge has no Tool or feature owner, so every surface and Agent keeps it.
    selected.add('minimax-code-product');
    if (capabilities.features.mavis) {
        // The composite `mavis` Skill is gone; its references became these. The ones
        // that own a namespace's tools are added by `addNamespaceSkills` below, from
        // the tools the Turn actually registers. These three own no tool at all —
        // they are bash and file-read guidance — so the mavis switch still owns them.
        selected.add('im-routing');
        selected.add('skill-management');
        selected.add('windows-tool-bootstrap');
        selected.add('create-agent');
    }
    if (gates.miniappAvailable === true &&
        hasTools(capabilities, ['read', 'write', 'edit', 'bash'])) {
        selected.add('miniapp-creator');
    }
    if (hasTools(capabilities, ['read', 'write', 'edit'])) {
        selected.add('extension-creator');
    }
    // Workflow guidance owned by the search_plugins / request_plugin extension tools.
    if (gates.pluginRecommendationAvailable === true)
        selected.add('plugin-management');
}
/**
 * The one entry for every namespace Skill: a Skill appears exactly while its own
 * namespace has a tool this Turn can run, and the registry decides which Skill that
 * is. Adding a namespace Skill is a row in BUILTIN_TOOL_NAMESPACES plus its tools —
 * never another `selected.add` here, which is how the gate and the tool filters
 * drifted apart before.
 */
function addNamespaceSkills(selected, capabilities, gates) {
    for (const namespace of availableBuiltinToolNamespaces({
        mavisEnabled: capabilities.features.mavis,
        desktopToolsAvailable: gates.desktopManageAvailable === true,
        cronToolsAvailable: gates.cronToolsAvailable === true,
        memoryToolsAvailable: gates.memoryToolsAvailable === true,
        coordinator: gates.coordinator === true,
    })) {
        if (COORDINATOR_HIDDEN_NAMESPACES.has(namespace) && gates.coordinator === true)
            continue;
        const skill = skillForNamespace(namespace);
        if (skill !== undefined)
            selected.add(skill);
    }
}
/**
 * Namespaces a trusted coordinator owns no tool of: the registry's coordinator
 * allowlist names none of their tools, so their Skill would only teach tools it
 * cannot call. Read from the same rule the tool filter reads, so the gate and
 * the filter cannot drift apart.
 */
const COORDINATOR_HIDDEN_NAMESPACES = new Set(coordinatorHiddenNamespaces());
function addRuntimeSkills(selected, capabilities, gates) {
    if (gates.resumeCodexAvailable === true && isAgentBuiltinToolEnabled(capabilities, 'bash')) {
        selected.add('resume-codex');
    }
}
function hasTools(capabilities, toolNames) {
    return toolNames.every((toolName) => isAgentBuiltinToolEnabled(capabilities, toolName));
}
//# sourceMappingURL=feature-owned-skills.js.map