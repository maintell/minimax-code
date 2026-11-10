import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'yaml';
const MODEL_ACCESS_AUTHORING_SKILL_NAME = 'model-access-extension-author';
const REFERENCES = ['package-layout.md', 'sign-in-patterns.md'];
let cached;
/**
 * The authoring Skill is `listed: false` in the shared registry: it is only offered on turns that
 * also carry the `model_access_extension` tool, by the tool owner. Fails closed when packaging is
 * incomplete so a broken build never advertises a Skill it cannot serve.
 */
export function readModelAccessAuthoringSkill() {
    if (cached)
        return cached;
    try {
        cached = loadSkill();
        return cached;
    }
    catch {
        return undefined;
    }
}
function loadSkill() {
    const location = resolveSkillPath();
    const body = readFileSync(location, 'utf8');
    const frontmatter = parseFrontmatter(body);
    if (frontmatter.name !== MODEL_ACCESS_AUTHORING_SKILL_NAME)
        throw new Error('invalid skill');
    const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
    if (!description)
        throw new Error('invalid skill');
    const references = REFERENCES.map((file) => {
        const text = readFileSync(join(dirname(location), 'references', file), 'utf8');
        return `\n\n---\n\n<!-- references/${file} -->\n\n${text.trim()}`;
    });
    return Object.freeze({
        name: MODEL_ACCESS_AUTHORING_SKILL_NAME,
        description,
        content: `${body.trim()}${references.join('')}\n`,
        location: pathToFileURL(location).href.replace(/^file:/u, 'files:'),
    });
}
function resolveSkillPath() {
    const relative = join('mavis', 'skills', MODEL_ACCESS_AUTHORING_SKILL_NAME, 'SKILL.md');
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        // src/service/model-access-extension/installation and its dist twin sit four levels below
        // the package root.
        resolve(here, '../../../../assets/agents', relative),
        resolve(here, 'assets/agents', relative),
        resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents', relative),
        resolve(process.cwd(), 'assets/agents', relative),
    ];
    for (const candidate of candidates) {
        try {
            readFileSync(candidate);
            return candidate;
        }
        catch {
            // Continue through source, compiled package and bundled layouts.
        }
    }
    throw new Error('model access authoring skill missing');
}
function parseFrontmatter(content) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
    const value = match ? yaml.parse(match[1] ?? '') : undefined;
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
/** Lets the turn's `skill` tool load the authoring Skill; every other name passes through. */
export function serveAuthoringSkill(tool, skill) {
    return {
        ...tool,
        impl: {
            async execute(ctx, rawInput, signal, onUpdate) {
                const requested = readSkillName(rawInput);
                if (requested?.trim().toLowerCase() !== skill.name) {
                    return tool.impl.execute(ctx, rawInput, signal, onUpdate);
                }
                if (signal?.aborted)
                    throw new Error('Operation aborted');
                ctx.loadedSkills?.add(skill.name);
                return skillResult(skill);
            },
        },
    };
}
function skillResult(skill) {
    const text = `# Skill: ${skill.name}\nLocation: ${skill.location}\n\n${skill.content}`;
    return {
        tool_name: 'skill',
        text,
        content: [{ type: 'text', text }],
        details: {
            kind: 'skill',
            skill: skill.name,
            found: true,
            readable: true,
            owner: 'model-access',
            source: 'builtin',
            location: skill.location,
        },
    };
}
function readSkillName(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const name = Reflect.get(value, 'name');
    return typeof name === 'string' ? name : undefined;
}
//# sourceMappingURL=authoring-skill.js.map