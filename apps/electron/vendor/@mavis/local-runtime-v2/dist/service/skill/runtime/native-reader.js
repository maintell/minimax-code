import { resolveFeatureAwareBuiltinSkillNames } from './feature-owned-skills.js';
export async function readNativeSkill(reads, input) {
    const { name } = input;
    const skill = await reads.readSkillByName(name, {
        ...input.scope,
        builtinSkillNames: resolveFeatureAwareBuiltinSkillNames(input.policy, input.gates),
    });
    if (skill) {
        return {
            content: skill.content,
            location: skill.locationUri,
            sourceKind: skill.sourceKind,
        };
    }
    const desktopSkill = input.desktopSkills?.find((candidate) => normalizedSkillName(candidate.name) === normalizedSkillName(name) &&
        isDesktopExtensionSkillSelected(input.scope.allowedSkillNames, input.scope.allowedExtensionSkillNames, candidate.pluginName, candidate.name));
    return desktopSkill
        ? {
            content: desktopSkill.content,
            location: desktopSkill.location,
            sourceKind: desktopSkill.sourceKind,
        }
        : undefined;
}
function normalizedSkillName(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function isDesktopExtensionSkillSelected(allowedSkillNames, selected, pluginName, skillName) {
    const name = normalizedSkillName(skillName);
    const qualified = `${normalizedSkillName(pluginName)}:${name}`;
    const includes = (values) => values?.some((candidate) => {
        const normalized = normalizedSkillName(candidate);
        return normalized === name || normalized === qualified;
    }) ?? true;
    return includes(allowedSkillNames) && includes(selected);
}
//# sourceMappingURL=native-reader.js.map