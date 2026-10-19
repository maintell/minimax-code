import Handlebars from 'handlebars';
import yaml from 'yaml';
import { AGENT_BUILTIN_TOOL_IDS, isAgentBuiltinToolEnabled, } from '@mavis/config';
import { roleDirectoryText } from '@mavis/agent-tools/desktop/subagent-roles';
const BUILTIN_HANDLEBARS = Handlebars.create();
export function createBuiltinPromptContext(input, featurePrompts) {
    const promptMode = input.promptMode ?? (input.promptProfile === 'tui' ? 'tui' : input.appMode);
    const capabilities = input.capabilities;
    const tools = Object.fromEntries(AGENT_BUILTIN_TOOL_IDS.map((toolName) => [
        toolName,
        isAgentBuiltinToolEnabled(capabilities, toolName),
    ]));
    const skills = Object.fromEntries((capabilities.skills ?? []).map((skill) => [skill, true]));
    skills.mavis = capabilities.features.mavis;
    return {
        tools,
        persona: capabilities.persona,
        profile: { tui: input.promptProfile === 'tui' },
        features: capabilities.features,
        skills,
        mode: {
            coding: promptMode === 'coding',
            work: promptMode === 'work',
            tui: promptMode === 'tui',
        },
        memory: { enabled: input.memoryEnabled ?? capabilities.features.mavis },
        cron: { enabled: input.cronEnabled ?? capabilities.features.mavis },
        surface: {
            interactive: input.surface !== 'task-child',
            taskChild: input.surface === 'task-child',
            cli: input.surface === 'cli',
        },
        featurePrompts,
        DATA_DIR: input.dataDirToken ?? '{{DATA_DIR}}',
        ROLE_DIRECTORY: roleDirectoryText(),
    };
}
export function renderBuiltinTemplate(template, context, source) {
    try {
        return BUILTIN_HANDLEBARS.compile(template, { noEscape: true, strict: true })(context);
    }
    catch (error) {
        throw new Error(`Invalid V2 built-in Agent prompt ${source}: ${describeError(error)}`, {
            cause: error,
        });
    }
}
export function parseFrontmatter(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw);
    if (!match)
        return { frontmatter: {}, body: raw };
    const parsed = parseYaml(match[1] ?? '');
    return {
        frontmatter: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {},
        body: raw.slice(match[0].length),
    };
}
export function stripFrontmatter(raw) {
    return parseFrontmatter(raw).body;
}
function parseYaml(raw) {
    return yaml.parse(raw);
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=prompt-renderer.js.map