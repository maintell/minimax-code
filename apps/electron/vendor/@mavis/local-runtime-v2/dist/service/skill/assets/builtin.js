import { resolveBuiltinSkillsDir, resolveBuiltinAgentsDir, isDirectory } from './locations.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getRuntimeRegion } from '@mavis/config';
import yaml from 'js-yaml';
const SKILL_FILE = 'SKILL.md';
const BUILTIN_SCOPE = 5;
const BUILTIN_SOURCE_TYPE = 1;
const BUILTIN_GLOBAL_SOURCE_KIND = 'builtin-global';
const BUILTIN_AGENT_SOURCE_KIND = 'builtin-agent';
const LEGACY_PRIMARY_AGENT_NAME = 'main';
const PRIMARY_AGENT_NAME = 'mavis';
const CN_DISABLED_BUILTIN_SKILLS = new Set(['x-link-reader']);
export function isLocalBuiltinSkillEnabled(name) {
    return getRuntimeRegion() !== 'cn' || !CN_DISABLED_BUILTIN_SKILLS.has(name);
}
async function listLocalBuiltinSkills() {
    const skillsDir = await resolveBuiltinSkillsDir();
    return skillsDir ? listBuiltinSkillsInDir(skillsDir, BUILTIN_GLOBAL_SOURCE_KIND) : [];
}
async function listLocalBuiltinSkillsForAgent(agentName) {
    const [globalSkills, agentSkills] = await Promise.all([
        listLocalBuiltinSkills(),
        listLocalAgentBuiltinSkills(agentName),
    ]);
    if (agentSkills.length === 0)
        return globalSkills;
    const merged = new Map();
    for (const skill of globalSkills)
        merged.set(skill.name, skill);
    for (const skill of agentSkills)
        merged.set(skill.name, skill);
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export async function readLocalBuiltinSkill(skillName, agentName) {
    const skill = await findLocalBuiltinSkill(skillName, agentName);
    if (!skill)
        return undefined;
    const content = await readOr(() => readFile(skill.location, 'utf8'), undefined);
    if (content === undefined)
        return undefined;
    return { ...skill, content };
}
async function findLocalBuiltinSkill(skillName, agentName) {
    if (agentName) {
        return (await listLocalBuiltinSkillsForAgent(agentName)).find((skill) => skill.name === skillName);
    }
    const globalSkill = (await listLocalBuiltinSkills()).find((skill) => skill.name === skillName);
    if (globalSkill)
        return globalSkill;
    return (await listLocalBuiltinSkillsForAgent(PRIMARY_AGENT_NAME)).find((skill) => skill.name === skillName);
}
async function listLocalAgentBuiltinSkills(agentName) {
    const normalizedAgentName = normalizeAgentName(agentName);
    const agentsDir = await resolveBuiltinAgentsDir();
    if (!agentsDir) {
        return [];
    }
    const skillsDir = join(agentsDir, normalizedAgentName, 'skills');
    if (!(await isDirectory(skillsDir))) {
        return [];
    }
    const skills = await listBuiltinSkillsInDir(skillsDir, BUILTIN_AGENT_SOURCE_KIND, normalizedAgentName);
    return skills;
}
async function listBuiltinSkillsInDir(skillsDir, sourceKind, agentName) {
    const entries = await readOr(() => readdir(skillsDir, { withFileTypes: true }), []);
    const skills = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const skillPath = join(skillsDir, entry.name, SKILL_FILE);
        const content = await readOr(() => readFile(skillPath, 'utf8'), undefined);
        if (!content)
            continue;
        const frontmatter = parseSkillFrontmatter(content);
        if (frontmatter.listed === false)
            continue;
        const name = frontmatter.name || entry.name;
        if (!isLocalBuiltinSkillEnabled(name))
            continue;
        skills.push({
            name,
            description: frontmatter.description || '',
            scope: BUILTIN_SCOPE,
            location: skillPath,
            source_type: BUILTIN_SOURCE_TYPE,
            source_kind: sourceKind,
            ...(frontmatter.requires_beta ? { requires_beta: frontmatter.requires_beta } : {}),
            ...(agentName ? { agent_name: agentName } : {}),
        });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
}
function parseSkillFrontmatter(content) {
    const match = /^---\n([\s\S]*?)\n---/.exec(content);
    if (!match)
        return {};
    const data = yaml.load(match[1] ?? '');
    if (data == null || typeof data !== 'object' || Array.isArray(data))
        return {};
    const obj = data;
    return {
        name: typeof obj.name === 'string' ? obj.name : undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        listed: typeof obj.listed === 'boolean' ? obj.listed : undefined,
        requires_beta: trimmedBeta(obj.requiresBeta),
    };
}
function normalizeAgentName(agentName) {
    return agentName === LEGACY_PRIMARY_AGENT_NAME ? PRIMARY_AGENT_NAME : agentName;
}
async function readOr(read, fallback) {
    try {
        return await read();
    }
    catch {
        return fallback;
    }
}
function trimmedBeta(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
export { getBuiltinSkillsDirCandidates, getBuiltinAgentsDirCandidates } from './locations.js';
//# sourceMappingURL=builtin.js.map