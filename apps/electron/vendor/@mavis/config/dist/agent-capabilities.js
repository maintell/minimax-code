export const AGENT_BUILTIN_TOOL_IDS = [
    'read',
    'write',
    'edit',
    'bash',
    'task_query',
    'task_output',
    'task_stop',
    'grep',
    'glob',
    'todowrite',
    'web_fetch',
    'website_deploy',
    'workspace_semantic_search',
];
/**
 * Standalone Builtin Matrix MCP tools that may be selected independently.
 * `web_search` is feature-owned because its Tool and Prompt are gated together
 * through `features.webSearch`.
 */
export const AGENT_BUILTIN_MCP_TOOL_IDS = [
    'images_understand',
    'image_synthesize',
    'images_search_and_download',
    'image_reverse_search',
    'submit_video_generation',
    'query_video_generation',
    'gen_videos',
    'batch_text_to_video',
    'batch_image_to_video',
    'get_voice_list',
    'batch_text_to_audio',
    'batch_text_to_music',
    'synthesize_speech',
    'batch_synthesize_speech',
    'audios_understand',
    'videos_understand',
    'transcribe_audio',
];
/**
 * Standalone Builtin Skills that may be selected independently.
 * Skills owned by another capability are derived at runtime so they cannot
 * outlive the Tool or feature that makes their instructions executable.
 */
export const AGENT_BUILTIN_SKILL_IDS = [
    'code-review',
    'deep-research',
    'deploy-website',
    'docx',
    'edit-deployed-website',
    'init',
    'lark-tools',
    'llm-call',
    'mcode-tools-master',
    'mavis-doctor',
    'pdf',
    'plugin-creator',
    'pptx',
    'skill-creator',
    'skill-refiner',
    'visual-page',
    'x-link-reader',
    'xlsx',
];
export const AGENT_CAPABILITY_OWNED_SKILL_IDS = [
    'control-in-app-browser',
    'resume-codex',
    'mavis',
    'create-agent',
    'minimax-code-product',
    'miniapp-creator',
];
const ROOT_KEYS = new Set([
    'modelConfigId',
    'persona',
    'tools',
    'builtinTools',
    'skills',
    'features',
]);
const PERSONA_KEYS = new Set(['enabled']);
const FEATURE_KEYS = new Set(['mavis', 'delegation', 'webSearch']);
const TOOL_IDS = new Set(AGENT_BUILTIN_TOOL_IDS);
const TASK_CONTROL_IDS = ['task_query', 'task_output', 'task_stop'];
const MCP_TOOL_IDS = new Set(AGENT_BUILTIN_MCP_TOOL_IDS);
const SKILL_IDS = new Set(AGENT_BUILTIN_SKILL_IDS);
const OWNED_SKILL_IDS = new Set(AGENT_CAPABILITY_OWNED_SKILL_IDS);
// Preserve existing user allowlists while removing a retired ID. The strict
// bundled-agent parser intentionally continues to reject retired IDs.
const RETIRED_TOLERANT_SKILL_IDS = new Set(['plan-mode']);
export function parseAgentsConfig(raw) {
    const root = asRecord(raw);
    const defaults = asRecord(root?.default);
    return { default: defaults ? parseTolerantAgentCapabilityConfig(defaults) : {} };
}
/** Strict parser for bundled built-in agent.md capability overrides. */
export function parseAgentCapabilityConfig(raw, path = 'agent') {
    if (raw === undefined)
        return {};
    const obj = readObject(raw, path);
    rejectUnknownKeys(obj, ROOT_KEYS, path);
    const result = {};
    if (obj.modelConfigId !== undefined) {
        if (typeof obj.modelConfigId !== 'string' || !obj.modelConfigId.trim()) {
            invalid(`${path}.modelConfigId`, 'must be a non-empty string');
        }
        result.modelConfigId = obj.modelConfigId.trim();
    }
    if (obj.persona !== undefined) {
        const persona = readObject(obj.persona, `${path}.persona`);
        rejectUnknownKeys(persona, PERSONA_KEYS, `${path}.persona`);
        if (persona.enabled !== undefined && typeof persona.enabled !== 'boolean') {
            invalid(`${path}.persona.enabled`, 'must be a boolean');
        }
        result.persona = {
            ...(typeof persona.enabled === 'boolean' ? { enabled: persona.enabled } : {}),
        };
    }
    if (obj.tools !== undefined) {
        if (!Array.isArray(obj.tools))
            invalid(`${path}.tools`, 'must be an array');
        result.tools = obj.tools.map((value, index) => {
            if (typeof value !== 'string' || !TOOL_IDS.has(value)) {
                invalid(`${path}.tools[${index}]`, `must be one of ${AGENT_BUILTIN_TOOL_IDS.join(', ')}`);
            }
            return value;
        });
    }
    if (obj.builtinTools !== undefined) {
        if (!Array.isArray(obj.builtinTools))
            invalid(`${path}.builtinTools`, 'must be an array');
        result.builtinTools = obj.builtinTools.map((value, index) => {
            if (value === 'web_search') {
                invalid(`${path}.builtinTools[${index}]`, 'web_search is feature-owned; use features.webSearch');
            }
            if (typeof value !== 'string' || !MCP_TOOL_IDS.has(value)) {
                invalid(`${path}.builtinTools[${index}]`, `must be one of ${AGENT_BUILTIN_MCP_TOOL_IDS.join(', ')}`);
            }
            return value;
        });
    }
    if (obj.skills !== undefined) {
        if (!Array.isArray(obj.skills))
            invalid(`${path}.skills`, 'must be an array');
        result.skills = obj.skills.map((value, index) => {
            if (typeof value === 'string' && OWNED_SKILL_IDS.has(value.trim())) {
                const name = value.trim();
                invalid(`${path}.skills[${index}]`, `${name} is capability-owned; use its owning Tool or feature switch`);
            }
            if (typeof value !== 'string' || !SKILL_IDS.has(value.trim())) {
                invalid(`${path}.skills[${index}]`, `must be one of ${AGENT_BUILTIN_SKILL_IDS.join(', ')}`);
            }
            return value.trim();
        });
    }
    if (obj.features !== undefined) {
        const features = readObject(obj.features, `${path}.features`);
        rejectUnknownKeys(features, FEATURE_KEYS, `${path}.features`);
        for (const key of FEATURE_KEYS) {
            if (features[key] !== undefined && typeof features[key] !== 'boolean') {
                invalid(`${path}.features.${key}`, 'must be a boolean');
            }
        }
        result.features = {
            ...(typeof features.mavis === 'boolean' ? { mavis: features.mavis } : {}),
            ...(typeof features.delegation === 'boolean' ? { delegation: features.delegation } : {}),
            ...(typeof features.webSearch === 'boolean' ? { webSearch: features.webSearch } : {}),
        };
    }
    return result;
}
function parseTolerantAgentCapabilityConfig(obj) {
    const result = {};
    if (typeof obj.modelConfigId === 'string' && obj.modelConfigId.trim()) {
        result.modelConfigId = obj.modelConfigId.trim();
    }
    const persona = asRecord(obj.persona);
    if (typeof persona?.enabled === 'boolean') {
        result.persona = { enabled: persona.enabled };
    }
    if (isKnownIdArray(obj.tools, TOOL_IDS)) {
        const tools = [...obj.tools];
        // Older user allowlists predate configurable task controls: those tools
        // remained available even with tools: [] or delegation disabled. Preserve
        // that behavior unless the list explicitly selects the new control IDs.
        // Bundled agent.md uses the strict parser and keeps its exact ceiling.
        if (!TASK_CONTROL_IDS.some((id) => tools.includes(id))) {
            tools.push(...TASK_CONTROL_IDS);
        }
        result.tools = tools;
    }
    if (isKnownIdArray(obj.builtinTools, MCP_TOOL_IDS)) {
        result.builtinTools = [...obj.builtinTools];
    }
    if (Array.isArray(obj.skills)) {
        const normalizedSkills = obj.skills.map((value) => typeof value === 'string' ? value.trim() : value);
        if (normalizedSkills.every((value) => typeof value === 'string' &&
            (SKILL_IDS.has(value) || RETIRED_TOLERANT_SKILL_IDS.has(value)) &&
            !OWNED_SKILL_IDS.has(value))) {
            result.skills = normalizedSkills.filter((value) => typeof value === 'string' && SKILL_IDS.has(value));
        }
    }
    const features = asRecord(obj.features);
    if (features) {
        const parsedFeatures = {};
        for (const key of FEATURE_KEYS) {
            if (typeof features[key] === 'boolean')
                parsedFeatures[key] = features[key];
        }
        if (Object.keys(parsedFeatures).length > 0)
            result.features = parsedFeatures;
    }
    return result;
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function isKnownIdArray(value, knownIds) {
    return (Array.isArray(value) && value.every((item) => typeof item === 'string' && knownIds.has(item)));
}
export function resolveAgentCapabilities(defaults = {}, override = {}) {
    return {
        persona: {
            enabled: override.persona?.enabled ?? defaults.persona?.enabled ?? true,
        },
        tools: cloneOptionalArray(override.tools ?? defaults.tools),
        builtinTools: cloneOptionalArray(override.builtinTools ?? defaults.builtinTools),
        skills: cloneOptionalArray(override.skills ?? defaults.skills),
        features: {
            mavis: override.features?.mavis ?? defaults.features?.mavis ?? true,
            delegation: override.features?.delegation ?? defaults.features?.delegation ?? true,
            webSearch: override.features?.webSearch ?? defaults.features?.webSearch ?? true,
        },
    };
}
export function isAgentBuiltinToolEnabled(capabilities, toolName) {
    return capabilities.tools === undefined || capabilities.tools.includes(toolName);
}
export function isAgentBuiltinMcpToolEnabled(capabilities, toolName) {
    return capabilities.builtinTools === undefined || capabilities.builtinTools.includes(toolName);
}
export function isAgentBuiltinSkillEnabled(capabilities, skillName) {
    return capabilities.skills === undefined || capabilities.skills.includes(skillName);
}
function cloneOptionalArray(value) {
    return value === undefined ? undefined : [...value];
}
function readObject(value, path) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        invalid(path, 'must be an object');
    }
    return value;
}
function rejectUnknownKeys(value, allowed, path) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            invalid(`${path}.${key}`, 'is not supported');
    }
}
function invalid(path, message) {
    throw new Error(`Invalid configuration at ${path}: ${message}`);
}
//# sourceMappingURL=agent-capabilities.js.map