import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
const SKILL_FILE = 'SKILL.md';
const USER_GLOBAL_SCOPE = 2;
const USER_AGENT_SCOPE = 1;
const USER_SOURCE_TYPE = 2;
const BUILTIN_SOURCE_TYPE = 1;
const USER_GLOBAL_SOURCE_KIND = 'user-mavis';
const USER_AGENT_SOURCE_KIND = 'agent-user';
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
export async function createLocalSkill(input) {
    const nameError = validateSkillName(input.name);
    if (nameError)
        return { ok: false, ...nameError };
    const agentNameError = validateAgentName(input.agentName);
    if (agentNameError)
        return { ok: false, ...agentNameError };
    if (await skillExists(input)) {
        return { ok: false, ...skillConflict(input.name) };
    }
    const contentNameError = validateUserSkillContentName(input.name, input.content);
    if (contentNameError)
        return { ok: false, ...contentNameError };
    const written = await writeUserSkill(input.dataDir, input.name, buildSkillContent(input.name, input.description, input.content), input.agentName);
    return { ok: true, skill: serializeSkill(written) };
}
async function readUserSkill(dataDir, name, agentName) {
    const skillPath = userSkillPath(dataDir, name, agentName);
    const content = await readOptionalSkillFile(skillPath);
    if (content === undefined)
        return undefined;
    const frontmatter = parseSkillFrontmatter(content);
    return {
        name,
        description: frontmatter.description || '',
        content,
        scope: agentName ? USER_AGENT_SCOPE : USER_GLOBAL_SCOPE,
        location: skillPath,
        source_type: USER_SOURCE_TYPE,
        source_kind: agentName ? USER_AGENT_SOURCE_KIND : USER_GLOBAL_SOURCE_KIND,
        ...(frontmatter.requires_beta ? { requires_beta: frontmatter.requires_beta } : {}),
        ...(agentName ? { agent_name: agentName } : {}),
    };
}
async function writeUserSkill(dataDir, name, content, agentName) {
    const skillPath = userSkillPath(dataDir, name, agentName);
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, content, 'utf8');
    const frontmatter = parseSkillFrontmatter(content);
    return {
        name,
        description: frontmatter.description || '',
        scope: agentName ? USER_AGENT_SCOPE : USER_GLOBAL_SCOPE,
        location: skillPath,
        source_type: USER_SOURCE_TYPE,
        source_kind: agentName ? USER_AGENT_SOURCE_KIND : USER_GLOBAL_SOURCE_KIND,
        ...(frontmatter.requires_beta ? { requires_beta: frontmatter.requires_beta } : {}),
        ...(agentName ? { agent_name: agentName } : {}),
    };
}
async function skillExists(input) {
    if (await readUserSkill(input.dataDir, input.name, input.agentName))
        return true;
    if (input.agentName && (await readUserSkill(input.dataDir, input.name, undefined)))
        return true;
    return input.hasBuiltinSkill(input.name, input.agentName);
}
function userSkillPath(dataDir, name, agentName) {
    const baseDir = agentName
        ? resolve(dataDir, 'agents', agentName, 'skills')
        : resolve(dataDir, 'skills');
    const skillDir = resolve(baseDir, name);
    if (skillDir !== baseDir && !skillDir.startsWith(`${baseDir}${sep}`)) {
        throw new Error(`Invalid skill path: ${name}`);
    }
    return join(skillDir, SKILL_FILE);
}
function buildSkillContent(name, description, content) {
    if (content.startsWith('---'))
        return content;
    const frontmatter = yaml.dump({ name, description }, { lineWidth: 120, noRefs: true }).trim();
    return `---\n${frontmatter}\n---\n\n${content}`;
}
function parseSkillFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
    if (!match)
        return {};
    const parsed = yaml.load(match[1] ?? '');
    if (!parsed || typeof parsed !== 'object')
        return {};
    const record = parsed;
    const display_name = readFrontmatterDisplayName(record);
    return {
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.description === 'string' ? { description: record.description } : {}),
        ...(display_name ? { display_name } : {}),
        ...(typeof record.requiresBeta === 'string' ? { requires_beta: record.requiresBeta } : {}),
        ...(typeof record.requires_beta === 'string' ? { requires_beta: record.requires_beta } : {}),
    };
}
function validateSkillName(name) {
    if (NAME_PATTERN.test(name))
        return undefined;
    return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `Invalid skill name "${name}": must be kebab-case starting with a letter or digit`,
    };
}
function validateUserSkillContentName(name, content) {
    const frontmatter = parseSkillFrontmatter(content);
    if (!frontmatter.name || frontmatter.name === name)
        return undefined;
    return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `Skill content frontmatter name "${frontmatter.name}" must match requested skill name "${name}"`,
    };
}
function serializeSkill(skill) {
    const isBuiltIn = skill.source_type === BUILTIN_SOURCE_TYPE;
    return {
        ...skill,
        scope: skillScopeLabel(skill),
        scope_type: skill.scope,
        isBuiltIn,
        is_builtin: isBuiltIn,
    };
}
function skillScopeLabel(skill) {
    return skill.agent_name ||
        skill.source_kind === USER_AGENT_SOURCE_KIND ||
        skill.source_kind === 'builtin-agent'
        ? 'agent'
        : 'global';
}
function validateAgentName(agentName) {
    if (agentName === undefined || AGENT_NAME_PATTERN.test(agentName))
        return undefined;
    return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `Invalid agent name "${agentName}": must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens`,
    };
}
function skillConflict(name) {
    return {
        status: 409,
        code: 'SKILL_NAME_CONFLICT',
        message: `Skill "${name}" already exists`,
    };
}
async function readOptionalSkillFile(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
function readFrontmatterDisplayName(record) {
    // Extract display_name from displayNames locale map (any locale) or
    // top-level display_name string.
    let display_name;
    if (typeof record.display_name === 'string') {
        display_name = record.display_name;
    }
    else if (record.displayNames && typeof record.displayNames === 'object') {
        const names = Object.values(record.displayNames);
        const first = names.find((v) => typeof v === 'string' && v.trim() !== '');
        if (typeof first === 'string')
            display_name = first;
    }
    return display_name;
}
//# sourceMappingURL=api.js.map