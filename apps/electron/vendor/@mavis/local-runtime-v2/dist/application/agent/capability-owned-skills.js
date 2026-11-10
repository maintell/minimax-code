import { MODEL_ACCESS_EXTENSION_TOOL_NAME, readModelAccessAuthoringSkill, serveAuthoringSkill, } from '../../service/model-access-extension/index.js';
import { resolveAgentPromptSurface, } from '../../service/turn-system/index.js';
function normalizedSkillName(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
/** Adds the Skills `ownedFor` returns for a rendered surface, replacing same-named ones. */
export function withCapabilityOwnedSkills(baseSkills, ownedFor) {
    const notOwned = (owned) => {
        const names = new Set(owned.map((skill) => normalizedSkillName(skill.name)));
        return (candidate) => !names.has(normalizedSkillName(candidate.name));
    };
    return {
        listRuntimeSkills: async (scope) => {
            const base = await baseSkills.listRuntimeSkills(scope);
            const owned = ownedFor(scope.surface);
            if (owned.length === 0)
                return base;
            return {
                ...base,
                skills: [
                    ...base.skills.filter(notOwned(owned)),
                    ...owned.map((skill) => ({
                        name: skill.name,
                        description: skill.description,
                        selectionScope: 'capability-owned',
                    })),
                ],
            };
        },
        renderCatalog: (scope) => {
            const owned = ownedFor(scope.surface);
            if (owned.length === 0)
                return baseSkills.renderCatalog(scope);
            return baseSkills.renderCatalog({
                ...scope,
                additionalSkills: [
                    ...(scope.additionalSkills ?? []).filter(notOwned(owned)),
                    ...owned.map((skill) => ({
                        name: skill.name,
                        description: skill.description,
                        builtin: true,
                    })),
                ],
            });
        },
    };
}
/**
 * The model access extension authoring tool and Skill. The tool needs the Desktop approval
 * surface and the local Runtime (never SSH or TUI), so both are offered on Electron-owned
 * interactive turns only, and the Skill only when the same turn also gets the tool.
 */
export function createModelAccessAuthoring(tool, runtimeOwnerKind) {
    const electron = tool !== undefined && runtimeOwnerKind === 'electron';
    return {
        /** The catalog sees the rendered surface rather than the Session. */
        skillFor: (surface) => electron && surface === 'interactive' && tool() !== undefined
            ? readModelAccessAuthoringSkill()
            : undefined,
        /** The turn's tools with the authoring tool added and the Skill tool serving its Skill. */
        tools: (tools, session) => {
            const offered = electron && resolveAgentPromptSurface(session, runtimeOwnerKind) === 'interactive';
            const extensionTool = offered ? tool?.() : undefined;
            if (!extensionTool ||
                tools.some((item) => item.def.name === MODEL_ACCESS_EXTENSION_TOOL_NAME))
                return tools;
            const authoringSkill = readModelAccessAuthoringSkill();
            const served = authoringSkill
                ? tools.map((item) => item.def.name === 'skill' ? serveAuthoringSkill(item, authoringSkill) : item)
                : tools;
            return [...served, extensionTool];
        },
    };
}
//# sourceMappingURL=capability-owned-skills.js.map