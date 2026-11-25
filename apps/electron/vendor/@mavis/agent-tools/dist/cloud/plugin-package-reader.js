/**
 * MiniMax Plugin package V1 manifest reader: PluginRef 校验，以及从已校验的包里读出
 * manifest、App、MCP、Skill、Hook。
 *
 * v1 cloud-runtime 与 v2 cloud-harness-server 共用（v1 原路径委托）。读文件由调用方注入：
 * v1 读本机解包目录，v2 读 harness 内存里的归档条目；`packageRoot` 只用于拼出结果里的路径。
 */
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { parsePluginHookDocuments } from '@mavis/plugin-hooks';
import { validatePluginPortablePath } from './plugin-package-contract.js';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const MANIFEST_PATH = '.minimax-plugin/plugin.json';
const PLUGIN_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTENT_DIGEST = /^sha256-tree-v1:[0-9a-f]{64}$/u;
const ICON_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/u;
const APP_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.app\.json$/u;
const MCP_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mcp\.json$/u;
const SKILL_PATH = /^skills\/[A-Za-z0-9._-]+\/SKILL\.md$/u;
const HOOK_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/u;
const SERVER_NAME = PLUGIN_NAME;
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/u;
const CONNECTOR_PROVIDER = /^[a-z0-9_-]{1,64}$/u;
const CATEGORY_NAMES = new Set([
    'Office',
    'Studio',
    'Design & Sites',
    'Code',
    'Business',
    'Sales',
    'Productivity',
    'Science & Healthcare',
    'Education',
    'Other',
]);
const MANIFEST_FIELDS = new Set([
    '$schema',
    'schemaVersion',
    'name',
    'displayName',
    'version',
    'description',
    'author',
    'icon',
    'darkIcon',
    'category',
    'exampleQueries',
    'apps',
    'mcpServers',
    'skills',
    'hooks',
]);
/** Cloud has no host capabilities; Skills that depend on them must not load without them. */
const HOST_CAPABILITY_MANIFEST_FIELDS = ['hostBindings', 'hostCapabilities'];
const APP_FIELDS = new Set(['$schema', 'schemaVersion', 'provider']);
const MCP_WRAPPER_FIELDS = new Set(['$schema', 'schemaVersion', 'mcpServers']);
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'description', 'timeout', 'tools']);
const REMOTE_FIELDS = new Set(['type', 'url', 'headers', 'description', 'timeout', 'tools']);
const TOOL_FIELDS = new Set(['name', 'description', 'inputSchema']);
export class CloudPluginPackageError extends Error {
    code;
    detail;
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
        this.name = 'CloudPluginPackageError';
    }
}
export function normalizePluginRefs(refs) {
    if (!refs || refs.length === 0)
        return [];
    const normalized = refs.map((ref, index) => normalizePluginRef(ref, index));
    normalized.sort(comparePluginRefs);
    const names = new Set();
    for (const ref of normalized) {
        if (names.has(ref.name)) {
            throw new CloudPluginPackageError('PLUGIN_REF_INVALID', `duplicate Plugin ${ref.name}`);
        }
        names.add(ref.name);
    }
    return normalized;
}
function normalizePluginRef(ref, index) {
    const name = nonEmpty(ref.name);
    const version = nonEmpty(ref.version);
    const dataOssKey = nonEmpty(ref.data_oss_key);
    const archiveSha256 = nonEmpty(ref.archive_sha256);
    const contentDigest = nonEmpty(ref.content_digest);
    const iconUrl = nonEmpty(ref.icon_url);
    const darkIconUrl = nonEmpty(ref.dark_icon_url);
    if (!name ||
        name.length > 80 ||
        !PLUGIN_NAME.test(name) ||
        !version ||
        version.length > 128 ||
        !SEMVER.test(version) ||
        !dataOssKey ||
        !archiveSha256 ||
        !SHA256.test(archiveSha256) ||
        !contentDigest ||
        !CONTENT_DIGEST.test(contentDigest)) {
        throw new CloudPluginPackageError('PLUGIN_REF_INVALID', `PluginRef at index ${index} is incomplete or malformed`);
    }
    return {
        name,
        version,
        data_oss_key: dataOssKey,
        archive_sha256: archiveSha256,
        content_digest: contentDigest,
        ...(iconUrl ? { icon_url: iconUrl } : {}),
        ...(darkIconUrl ? { dark_icon_url: darkIconUrl } : {}),
    };
}
function comparePluginRefs(left, right) {
    return (left.name.localeCompare(right.name) ||
        left.version.localeCompare(right.version) ||
        left.content_digest.localeCompare(right.content_digest) ||
        left.archive_sha256.localeCompare(right.archive_sha256) ||
        left.data_oss_key.localeCompare(right.data_oss_key));
}
function nonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export async function parseCloudPluginPackage(packageRoot, ref, readFile) {
    const source = { root: packageRoot, readFile };
    const manifest = await readJsonObject(source, MANIFEST_PATH);
    if (HOST_CAPABILITY_MANIFEST_FIELDS.some((field) => Object.hasOwn(manifest, field))) {
        fail('MANIFEST_SCHEMA_INVALID', 'manifest requires host capabilities');
    }
    const ignoredManifestFields = Object.keys(manifest).filter((key) => !MANIFEST_FIELDS.has(key));
    if ((manifest.$schema !== undefined && typeof manifest.$schema !== 'string') ||
        manifest.schemaVersion !== 1) {
        fail('MANIFEST_SCHEMA_INVALID', 'manifest schemaVersion must be 1');
    }
    const name = requiredString(manifest.name, 'MANIFEST_SCHEMA_INVALID', 'name');
    const version = requiredString(manifest.version, 'MANIFEST_SCHEMA_INVALID', 'version');
    if (name.length > 80 || !PLUGIN_NAME.test(name))
        fail('MANIFEST_SCHEMA_INVALID', 'name is invalid');
    if (version.length > 128 || !SEMVER.test(version)) {
        fail('MANIFEST_SCHEMA_INVALID', 'version is not semver');
    }
    if (name !== ref.name || version !== ref.version) {
        fail('PLUGIN_IDENTITY_MISMATCH', 'manifest name/version does not match PluginRef');
    }
    const displayName = optionalNonEmptyString(manifest.displayName, 'MANIFEST_SCHEMA_INVALID', 'displayName');
    requiredString(manifest.description, 'MANIFEST_SCHEMA_INVALID', 'description');
    requiredString(manifest.author, 'MANIFEST_SCHEMA_INVALID', 'author');
    // Existing artifacts may still carry the retired Tools category. Runtime
    // loading remains compatible, while current publishers reject new use.
    if (typeof manifest.category !== 'string' ||
        (manifest.category !== 'Tools' && !CATEGORY_NAMES.has(manifest.category))) {
        fail('MANIFEST_SCHEMA_INVALID', 'category is invalid');
    }
    const queries = stringArray(manifest.exampleQueries, 'MANIFEST_SCHEMA_INVALID', 'exampleQueries');
    if (queries.some((query) => !query.trim())) {
        fail('MANIFEST_SCHEMA_INVALID', 'exampleQueries contains a blank value');
    }
    const icon = referencePath(manifest.icon, ICON_PATH, 'icon');
    const darkIcon = manifest.darkIcon === undefined
        ? undefined
        : referencePath(manifest.darkIcon, ICON_PATH, 'darkIcon');
    const apps = referenceArray(manifest.apps, APP_PATH, 'apps');
    const mcpFiles = referenceArray(manifest.mcpServers, MCP_PATH, 'mcpServers');
    const skillFiles = referenceArray(manifest.skills, SKILL_PATH, 'skills');
    const hookFiles = manifest.hooks === undefined ? [] : referenceArray(manifest.hooks, HOOK_PATH, 'hooks');
    if (apps.length + mcpFiles.length + skillFiles.length + hookFiles.length === 0) {
        fail('MANIFEST_SCHEMA_INVALID', 'Plugin has no capability');
    }
    await readPackageFile(source, icon);
    if (darkIcon)
        await readPackageFile(source, darkIcon);
    const appProviders = await Promise.all(apps.map((appPath) => validateApp(source, appPath)));
    const mcpServers = (await Promise.all(mcpFiles.map((relativePath) => readMcpFile(source, relativePath, ref)))).flat();
    assertUnique(mcpServers.map((server) => server.name), 'MCP_SCHEMA_INVALID', 'MCP server');
    const skills = await Promise.all(skillFiles.map((relativePath) => readSkill(source, relativePath, ref)));
    assertUnique(skills.map((skill) => skill.name), 'SKILL_SCHEMA_INVALID', 'Skill');
    const hookDocuments = await Promise.all(hookFiles.map(async (sourcePath) => ({
        sourcePath,
        value: await readJsonObject(source, sourcePath),
    })));
    const parsedHooks = parsePluginHookDocuments({
        pluginName: ref.name,
        pluginRoot: packageRoot,
        sourceFormat: 'MINIMAX',
        documents: hookDocuments,
    });
    const pluginDataDir = path.join(path.dirname(packageRoot), '.plugin-data', ref.name);
    const hooks = parsedHooks.handlers.map((handler) => ({
        ...handler,
        pluginDataDir,
        activationKey: ref.content_digest,
    }));
    if (appProviders.length + mcpServers.length + skills.length + hooks.length === 0) {
        fail('MANIFEST_SCHEMA_INVALID', 'Plugin has no executable capability');
    }
    return {
        plugin: {
            name,
            ...(displayName ? { displayName } : {}),
            version,
            ...(ref.icon_url ? { iconUrl: ref.icon_url } : {}),
            ...(ref.dark_icon_url ? { darkIconUrl: ref.dark_icon_url } : {}),
            contentDigest: ref.content_digest,
            packageRoot,
            appProviders: [...new Set(appProviders)],
        },
        skills,
        mcpServers,
        hooks,
        hookDiagnostics: parsedHooks.diagnostics.map(({ code, sourcePath }) => ({ code, sourcePath })),
        ignoredManifestFields,
    };
}
async function validateApp(source, relativePath) {
    const value = await readJsonObject(source, relativePath);
    assertExactFields(value, APP_FIELDS, 'APP_SCHEMA_INVALID', relativePath);
    if ((value.$schema !== undefined && typeof value.$schema !== 'string') ||
        value.schemaVersion !== 1 ||
        typeof value.provider !== 'string' ||
        !CONNECTOR_PROVIDER.test(value.provider)) {
        fail('APP_SCHEMA_INVALID', `${relativePath} has an invalid App reference`);
    }
    return value.provider;
}
async function readMcpFile(source, relativePath, ref) {
    const value = await readJsonObject(source, relativePath);
    assertExactFields(value, MCP_WRAPPER_FIELDS, 'MCP_SCHEMA_INVALID', relativePath);
    if ((value.$schema !== undefined && typeof value.$schema !== 'string') ||
        value.schemaVersion !== 1 ||
        !isRecord(value.mcpServers) ||
        Object.keys(value.mcpServers).length === 0) {
        fail('MCP_SCHEMA_INVALID', `${relativePath} has an invalid V1 wrapper`);
    }
    return Object.entries(value.mcpServers)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, raw]) => {
        if (name.length > 80 || !SERVER_NAME.test(name) || !isRecord(raw)) {
            fail('MCP_SCHEMA_INVALID', `${relativePath} contains an invalid server entry`);
        }
        const type = raw.type;
        if (type !== 'stdio' && type !== 'streamable-http' && type !== 'sse') {
            fail('MCP_SCHEMA_INVALID', `${name} has an invalid transport`);
        }
        assertExactFields(raw, type === 'stdio' ? STDIO_FIELDS : REMOTE_FIELDS, 'MCP_SCHEMA_INVALID', name);
        if (type === 'stdio')
            validateStdioServer(raw, name);
        else
            validateRemoteServer(raw, name);
        validateMcpCommon(raw, name);
        return {
            pluginName: ref.name,
            pluginVersion: ref.version,
            packageContentDigest: ref.content_digest,
            name,
            ...(typeof raw.description === 'string' ? { description: raw.description.trim() } : {}),
            config: raw,
            resolved: resolveMcpServer(source.root, name, raw),
        };
    });
}
function resolveMcpServer(packageRoot, name, raw) {
    const transport = resolveMcpTransport(packageRoot, raw);
    return {
        name,
        transport,
        enabled: true,
        ...(typeof raw.timeout === 'number' ? { timeout: raw.timeout } : {}),
    };
}
function resolveMcpTransport(packageRoot, raw) {
    if (raw.type === 'stdio') {
        const args = Array.isArray(raw.args) ? raw.args : [];
        return {
            type: 'stdio',
            command: raw.command,
            args: args.map((arg) => resolveStdioArg(packageRoot, arg)),
            ...(raw.env !== undefined ? { env: raw.env } : {}),
        };
    }
    return {
        type: raw.type === 'streamable-http' ? 'http' : 'sse',
        url: raw.url,
        ...(raw.headers !== undefined ? { headers: raw.headers } : {}),
    };
}
function resolveStdioArg(packageRoot, value) {
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
        fail('MCP_SCHEMA_INVALID', 'MCP stdio argument must not be an absolute path');
    }
    if (!/^\.{1,2}[/\\]/u.test(value))
        return value;
    const candidate = path.resolve(packageRoot, ...value.split(/[/\\]/u));
    const relative = path.relative(packageRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail('PATH_OUTSIDE_ROOT', 'MCP argument path escapes Plugin root');
    }
    return candidate;
}
function validateStdioServer(raw, name) {
    const command = requiredString(raw.command, 'MCP_SCHEMA_INVALID', `${name}.command`);
    if (/[/\\]/u.test(command)) {
        fail('MCP_SCHEMA_INVALID', `${name} must launch package files through a PATH interpreter`);
    }
    if (raw.args !== undefined)
        stringArray(raw.args, 'MCP_SCHEMA_INVALID', `${name}.args`);
    if (raw.env !== undefined)
        stringRecord(raw.env, 'MCP_SCHEMA_INVALID', `${name}.env`);
}
function validateRemoteServer(raw, name) {
    const url = requiredString(raw.url, 'MCP_SCHEMA_INVALID', `${name}.url`);
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        fail('MCP_SCHEMA_INVALID', `${name}.url is invalid`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        fail('MCP_SCHEMA_INVALID', `${name}.url is invalid`);
    }
    if (raw.headers !== undefined) {
        stringRecord(raw.headers, 'MCP_SCHEMA_INVALID', `${name}.headers`);
    }
}
function validateMcpCommon(raw, name) {
    optionalNonEmptyString(raw.description, 'MCP_SCHEMA_INVALID', `${name}.description`);
    if (raw.timeout !== undefined &&
        (!Number.isInteger(raw.timeout) || raw.timeout < 1)) {
        fail('MCP_SCHEMA_INVALID', `${name}.timeout must be a positive integer`);
    }
    if (raw.tools === undefined)
        return;
    if (!Array.isArray(raw.tools))
        fail('MCP_SCHEMA_INVALID', `${name}.tools must be an array`);
    const names = [];
    for (const [index, tool] of raw.tools.entries()) {
        if (!isRecord(tool))
            fail('MCP_SCHEMA_INVALID', `${name}.tools[${index}] is not an object`);
        assertExactFields(tool, TOOL_FIELDS, 'MCP_SCHEMA_INVALID', `${name}.tools[${index}]`);
        const toolName = requiredString(tool.name, 'MCP_SCHEMA_INVALID', `${name}.tools[${index}].name`);
        if (toolName.length > 80 || !TOOL_NAME.test(toolName)) {
            fail('MCP_SCHEMA_INVALID', `${name} has an invalid declared tool`);
        }
        names.push(toolName);
        optionalNonEmptyString(tool.description, 'MCP_SCHEMA_INVALID', `${name}.${toolName}.description`);
        if (tool.inputSchema !== undefined && !isRecord(tool.inputSchema)) {
            fail('MCP_SCHEMA_INVALID', `${name}.${toolName}.inputSchema is not an object`);
        }
    }
    assertUnique(names, 'MCP_SCHEMA_INVALID', `${name} declared tool`);
}
async function readSkill(source, relativePath, ref) {
    const content = await readPackageText(source, relativePath);
    const frontmatter = parseSkillFrontmatter(content, relativePath);
    const expectedName = path.posix.basename(path.posix.dirname(relativePath));
    const name = optionalNonEmptyString(frontmatter.name, 'SKILL_SCHEMA_INVALID', `${relativePath}.name`);
    const description = optionalNonEmptyString(frontmatter.description, 'SKILL_SCHEMA_INVALID', `${relativePath}.description`);
    if (!name || name !== expectedName || !description) {
        fail('SKILL_SCHEMA_INVALID', `${relativePath} frontmatter does not match its directory`);
    }
    const skillRoot = path.dirname(resolvePackagePath(source.root, relativePath));
    return {
        key: `OFFICIAL:${ref.name}:${name}:${ref.content_digest}`,
        pluginName: ref.name,
        pluginVersion: ref.version,
        packageContentDigest: ref.content_digest,
        name,
        description,
        content,
        skillRoot,
    };
}
function parseSkillFrontmatter(content, relativePath) {
    const opening = /^---\r?\n/u.exec(content);
    if (!opening)
        fail('SKILL_SCHEMA_INVALID', `${relativePath} must start with YAML frontmatter`);
    const remainder = content.slice(opening[0].length);
    const closing = /(?:^|\r?\n)---(?:\r?\n|$)/u.exec(remainder);
    if (!closing || closing.index === undefined) {
        fail('SKILL_SCHEMA_INVALID', `${relativePath} has unclosed YAML frontmatter`);
    }
    const prefixLength = closing[0].startsWith('\r\n') ? 2 : closing[0].startsWith('\n') ? 1 : 0;
    let parsed;
    try {
        parsed = loadYaml(remainder.slice(0, closing.index + prefixLength), { json: false });
    }
    catch {
        fail('SKILL_SCHEMA_INVALID', `${relativePath} has invalid YAML frontmatter`);
    }
    if (!isRecord(parsed))
        fail('SKILL_SCHEMA_INVALID', `${relativePath} frontmatter must be a mapping`);
    return parsed;
}
async function readJsonObject(source, relativePath) {
    const content = await readPackageText(source, relativePath);
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        fail('PLUGIN_JSON_INVALID', `${relativePath} is not valid JSON`);
    }
    if (!isRecord(value))
        fail('PLUGIN_JSON_INVALID', `${relativePath} must be an object`);
    return value;
}
async function readPackageText(source, relativePath) {
    const bytes = await readPackageFile(source, relativePath);
    let content;
    try {
        content = UTF8_DECODER.decode(bytes);
    }
    catch {
        fail('PLUGIN_TEXT_INVALID_UTF8', `${relativePath} is not valid UTF-8`);
    }
    if (content.charCodeAt(0) === 0xfeff) {
        fail('PLUGIN_TEXT_BOM_NOT_ALLOWED', `${relativePath} starts with a BOM`);
    }
    return content;
}
async function readPackageFile(source, relativePath) {
    resolvePackagePath(source.root, relativePath);
    try {
        return await source.readFile(relativePath);
    }
    catch {
        fail('PLUGIN_FILE_NOT_FOUND', `${relativePath} is not readable`);
    }
}
function resolvePackagePath(packageRoot, relativePath) {
    validatePluginPortablePath(relativePath);
    const target = path.resolve(packageRoot, ...relativePath.split('/'));
    const relative = path.relative(packageRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail('PATH_OUTSIDE_ROOT', `${relativePath} escapes Plugin root`);
    }
    return target;
}
function referenceArray(value, pattern, label) {
    const values = stringArray(value, 'MANIFEST_SCHEMA_INVALID', label);
    assertUnique(values, 'MANIFEST_SCHEMA_INVALID', label);
    for (const item of values)
        referencePath(item, pattern, label);
    return values;
}
function referencePath(value, pattern, label) {
    const parsed = requiredString(value, 'MANIFEST_SCHEMA_INVALID', label);
    if (parsed.length > 512 || !pattern.test(parsed)) {
        fail('MANIFEST_SCHEMA_INVALID', `${label} contains an invalid path`);
    }
    validatePluginPortablePath(parsed);
    return parsed;
}
function stringArray(value, code, label) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        fail(code, `${label} must be a string array`);
    }
    return value;
}
function stringRecord(value, code, label) {
    if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
        fail(code, `${label} must map strings to strings`);
    }
    return value;
}
function requiredString(value, code, label) {
    const parsed = optionalNonEmptyString(value, code, label);
    if (!parsed)
        fail(code, `${label} is required`);
    return parsed;
}
function optionalNonEmptyString(value, code, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !value.trim())
        fail(code, `${label} must be non-empty`);
    return value.trim();
}
function assertExactFields(value, fields, code, label) {
    if (Object.keys(value).some((key) => !fields.has(key)))
        fail(code, `${label} has an unknown field`);
}
function assertUnique(values, code, label) {
    if (new Set(values).size !== values.length)
        fail(code, `${label} contains a duplicate`);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(code, detail) {
    throw new CloudPluginPackageError(code, detail);
}
//# sourceMappingURL=plugin-package-reader.js.map