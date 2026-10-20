import { parseCompatibleMcpObject } from '../../mcp/config.js';
import { readPluginSkill } from '../../skill/reader.js';
import { canonicalizePluginRoot, isRecord, listDirectChildDirectories, pluginPathExists, readPluginJsonObject, resolvePluginDirectory, resolvePluginFile, } from './filesystem.js';
import { PluginReaderError, readerFail } from './reader-errors.js';
import { readCompatiblePluginAgents } from './agent/compatible.js';
import { readPluginHooks } from './hook/reader.js';
const CLAUDE_MANIFEST_PATH = '.\u0063\u006c\u0061\u0075\u0064\u0065-plugin/plugin.json';
const CODEX_MANIFEST_PATH = '.codex-plugin/plugin.json';
export async function readCompatiblePluginPackage(packageRoot, options = {}) {
    const root = await canonicalizePluginRoot(packageRoot, { rejectSymlink: true });
    const kind = options.kind ?? 'CLAUDE_CODE';
    const manifestRelativePath = kind === 'CODEX' ? CODEX_MANIFEST_PATH : CLAUDE_MANIFEST_PATH;
    const { path: manifestPath, value: manifest } = await readPluginJsonObject(root, manifestRelativePath);
    const name = stringValue(manifest.name);
    if (!name)
        readerFail('MANIFEST_SCHEMA_INVALID', 'Compatible Plugin name is required');
    const skills = await readCompatibleSkills(root, manifest.skills);
    const mcp = await readCompatibleMcp(root, manifest.mcpServers);
    const iconPath = await readOptionalIcon(root, manifest.icon);
    const author = readAuthor(manifest.author);
    const hookResult = await readPluginHooks(root, {
        pluginName: name,
        declared: manifest.hooks,
        sourceFormat: kind === 'CODEX' ? 'CODEX' : 'CLAUDE',
        defaultPath: 'hooks/hooks.json',
        manifestPath: manifestRelativePath,
    });
    const agentResult = kind !== 'CODEX'
        ? await readCompatiblePluginAgents(root, {
            pluginName: name,
            declared: manifest.agents,
            skills,
        })
        : { agents: [], diagnostics: [] };
    if (mcp.servers.length + skills.length + hookResult.hooks.length + agentResult.agents.length ===
        0) {
        readerFail('MANIFEST_SCHEMA_INVALID', 'Compatible Plugin has no supported executable capability');
    }
    return {
        source: kind === 'CODEX' ? 'LOCAL_CODEX' : 'LOCAL_\u0043\u004c\u0041\u0055\u0044\u0045',
        manifestKind: kind,
        rootPath: root.path,
        manifestPath,
        name,
        ...compatibleMetadata(manifest, author, iconPath),
        category: 'Other',
        exampleQueries: [],
        apps: [],
        mcpServers: mcp.servers,
        skills,
        hooks: hookResult.hooks,
        ...(agentResult.agents.length > 0 ? { agents: agentResult.agents } : {}),
        diagnostics: [...mcp.diagnostics, ...hookResult.diagnostics, ...agentResult.diagnostics],
    };
}
function compatibleMetadata(manifest, author, iconPath) {
    const displayName = stringValue(manifest.displayName);
    const version = stringValue(manifest.version);
    const description = stringValue(manifest.description);
    return {
        ...(displayName ? { displayName } : {}),
        ...(version ? { version } : {}),
        ...(description ? { description } : {}),
        ...(author ? { author } : {}),
        ...(iconPath ? { iconPath } : {}),
    };
}
async function readCompatibleSkills(root, declared) {
    const sourceDirectories = [];
    if (await pluginPathExists(root, 'skills', 'directory'))
        sourceDirectories.push('skills');
    for (const relativePath of stringOrStringArray(declared)) {
        await resolvePluginDirectory(root, relativePath);
        sourceDirectories.push(relativePath);
    }
    const skills = [];
    const seenFiles = new Set();
    for (const sourceDirectory of sourceDirectories) {
        if (await pluginPathExists(root, `${sourceDirectory}/SKILL.md`, 'file')) {
            await addSkill(root, `${sourceDirectory}/SKILL.md`, skills, seenFiles);
            continue;
        }
        for (const child of await listDirectChildDirectories(root, sourceDirectory)) {
            const skillFile = `${child.relativePath}/SKILL.md`;
            if (await pluginPathExists(root, skillFile, 'file')) {
                await addSkill(root, skillFile, skills, seenFiles);
            }
        }
    }
    return skills;
}
async function addSkill(root, relativePath, skills, seenFiles) {
    const file = await resolvePluginFile(root, relativePath);
    if (seenFiles.has(file))
        return;
    seenFiles.add(file);
    skills.push(await readPluginSkill(root, relativePath));
}
async function readCompatibleMcp(root, declared) {
    const groups = [];
    if (await pluginPathExists(root, '.mcp.json', 'file')) {
        groups.push(await readCompatibleMcpPath(root, '.mcp.json'));
    }
    if (isRecord(declared)) {
        groups.push(await parseCompatibleMcpObject(root, declared));
    }
    else {
        for (const relativePath of stringOrStringArray(declared)) {
            groups.push(await readCompatibleMcpPath(root, relativePath));
        }
    }
    const servers = [];
    const diagnostics = groups.flatMap((group) => group.diagnostics);
    const seenNames = new Set();
    for (const group of groups) {
        for (const server of group.servers) {
            if (seenNames.has(server.name)) {
                diagnostics.push({
                    code: 'MCP_SERVER_DUPLICATE',
                    capability: 'MCP',
                    name: server.name,
                });
                continue;
            }
            seenNames.add(server.name);
            servers.push(server);
        }
    }
    return { servers, diagnostics };
}
async function readCompatibleMcpPath(root, relativePath) {
    const { value } = await readPluginJsonObject(root, relativePath);
    return parseCompatibleMcpObject(root, value);
}
async function readOptionalIcon(root, value) {
    const relativePath = stringValue(value);
    if (!relativePath || !/\.(?:png|jpe?g|webp)$/iu.test(relativePath))
        return undefined;
    try {
        return await resolvePluginFile(root, relativePath);
    }
    catch (error) {
        if (error instanceof PluginReaderError)
            return undefined;
        throw error;
    }
}
function readAuthor(value) {
    if (typeof value === 'string')
        return value.trim() || undefined;
    return isRecord(value) ? stringValue(value.name) : undefined;
}
function stringOrStringArray(value) {
    if (typeof value === 'string' && value.trim())
        return [value];
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && !!item.trim());
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
//# sourceMappingURL=compatibility-reader.js.map