import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { AgentConfigError, parseCanonicalAgentMarkdownSource, } from '../../../../agent/storage/canonical-agent-config.js';
import { pluginPathExists, resolvePluginDirectory, } from '../filesystem.js';
import { PluginReaderError } from '../reader-errors.js';
import { acceptPluginAgents, agentDiagnostic, readAgentMarkdown, } from './accept.js';
import { CompatibleAgentFieldError, normalizeCompatibleAgentFrontmatter, } from './compatible-frontmatter.js';
const MAX_COMPATIBLE_AGENT_FILES = 256;
const MAX_COMPATIBLE_AGENT_DEPTH = 8;
const DEFAULT_AGENT_DIRECTORY = 'agents';
const COMPATIBLE_SOURCE_FORMAT = '\u0043\u004c\u0041\u0055\u0044\u0045';
/**
 * Compatible Plugin semantics: manifest `agents` replaces the default recursive
 * `agents/**\/*.md` scan. A broken Agent is skipped with a diagnostic.
 */
export async function readCompatiblePluginAgents(root, input) {
    const diagnostics = [];
    const sources = await compatibleAgentSources(root, input.declared, diagnostics);
    const candidates = [];
    for (const source of sources) {
        const candidate = await readCompatibleAgentCandidate(root, source, diagnostics);
        if (candidate)
            candidates.push(candidate);
    }
    return acceptPluginAgents(input, candidates, diagnostics);
}
async function compatibleAgentSources(root, declared, diagnostics) {
    const hasDefaultDirectory = await pluginPathExists(root, DEFAULT_AGENT_DIRECTORY, 'directory');
    if (declared === undefined) {
        return hasDefaultDirectory ? scanCompatibleAgentDirectory(root, diagnostics) : [];
    }
    const declaredPaths = typeof declared === 'string' ? [declared] : declared;
    if (!Array.isArray(declaredPaths)) {
        diagnostics.push(agentDiagnostic('AGENT_PATH_INVALID', 'agents'));
        return [];
    }
    const sources = [];
    for (const entry of declaredPaths) {
        if (typeof entry !== 'string' || !entry.trim().toLowerCase().endsWith('.md')) {
            diagnostics.push(agentDiagnostic('AGENT_PATH_INVALID', String(entry)));
            continue;
        }
        sources.push({ agentPath: entry.trim(), directorySegments: [] });
    }
    if (hasDefaultDirectory) {
        const declaredFiles = new Set(sources.map((source) => normalizedAgentPath(source.agentPath)));
        const defaultFiles = await scanCompatibleAgentDirectory(root, []);
        if (defaultFiles.some((source) => !declaredFiles.has(normalizedAgentPath(source.agentPath)))) {
            diagnostics.push(agentDiagnostic('AGENT_DEFAULT_DIRECTORY_IGNORED', DEFAULT_AGENT_DIRECTORY));
        }
    }
    return sources;
}
function normalizedAgentPath(agentPath) {
    return agentPath.replaceAll('\\', '/').replace(/^\.\//u, '');
}
async function scanCompatibleAgentDirectory(root, diagnostics) {
    const sources = [];
    const pending = [
        { relativePath: DEFAULT_AGENT_DIRECTORY, segments: [] },
    ];
    while (pending.length > 0) {
        const directory = pending.shift();
        const absolute = await resolvePluginDirectory(root, directory.relativePath);
        const children = (await readdir(absolute, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
            if (child.isDirectory() && directory.segments.length < MAX_COMPATIBLE_AGENT_DEPTH) {
                pending.push({
                    relativePath: `${directory.relativePath}/${child.name}`,
                    segments: [...directory.segments, child.name],
                });
            }
        }
        for (const child of children.filter(isMarkdownFile)) {
            if (sources.length === MAX_COMPATIBLE_AGENT_FILES) {
                diagnostics.push(agentDiagnostic('AGENT_FILES_TRUNCATED', DEFAULT_AGENT_DIRECTORY));
                return sources;
            }
            sources.push({
                agentPath: `${directory.relativePath}/${child.name}`,
                directorySegments: directory.segments,
            });
        }
    }
    return sources;
}
function isMarkdownFile(entry) {
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md');
}
async function readCompatibleAgentCandidate(root, source, diagnostics) {
    const stem = path.posix.basename(source.agentPath.replaceAll('\\', '/')).replace(/\.md$/iu, '');
    try {
        const file = await readAgentMarkdown(root, source.agentPath);
        const parsed = parseCanonicalAgentMarkdownSource(file.content);
        const normalized = normalizeCompatibleAgentFrontmatter(parsed.frontmatter, source.agentPath);
        diagnostics.push(...normalized.diagnostics);
        return {
            segments: [...source.directorySegments, normalized.fields.name ?? stem],
            sourceFormat: COMPATIBLE_SOURCE_FORMAT,
            agentPath: source.agentPath,
            agentFilePath: file.path,
            content: file.content,
            config: compatibleCandidateConfig(normalized.fields, parsed.body),
        };
    }
    catch (error) {
        if (error instanceof PluginReaderError ||
            error instanceof AgentConfigError ||
            error instanceof CompatibleAgentFieldError) {
            diagnostics.push(agentDiagnostic('AGENT_INVALID', source.agentPath));
            return undefined;
        }
        throw error;
    }
}
function compatibleCandidateConfig(fields, body) {
    return {
        description: fields.description,
        systemPrompt: body,
        ...(fields.effort ? { effort: fields.effort } : {}),
        ...(fields.tools === undefined ? {} : { tools: fields.tools }),
        ...(fields.disallowedTools === undefined ? {} : { disallowedTools: fields.disallowedTools }),
        ...(fields.skills === undefined ? {} : { skills: fields.skills }),
    };
}
//# sourceMappingURL=compatible.js.map