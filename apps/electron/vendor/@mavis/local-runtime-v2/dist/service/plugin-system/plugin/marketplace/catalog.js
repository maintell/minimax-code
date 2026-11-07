import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PluginSystemError } from '../../errors.js';
import { isInstallablePluginName } from '../local/install-directory.js';
import { MARKETPLACE_CATEGORY_NAMES } from '../package/types.js';
import { GitRemote, isFullCommitSha, isSafeGitRef, normalizeRepositoryPath, } from '../source/git-remote.js';
import { MarketplaceErrorCode, marketplaceError } from './errors.js';
/**
 * The Claude Code plugin directory. Unicode-escaped like the other
 * compatible-format paths (see `package/compatibility-reader.ts`).
 */
export const COMPATIBLE_PLUGIN_DIRECTORY = '.\u0063\u006c\u0061\u0075\u0064\u0065-plugin';
/** Looked up in this order (Codex, then Claude Code). */
const CATALOG_FILES = [
    '.agents/plugins/marketplace.json',
    `${COMPATIBLE_PLUGIN_DIRECTORY}/marketplace.json`,
];
/** Directories holding a catalog; always part of a sparse checkout. */
export const CATALOG_DIRECTORIES = ['.agents/plugins', COMPATIBLE_PLUGIN_DIRECTORY];
/** Entry fields that define Plugin components (Claude Code marketplace semantics). */
const COMPONENT_FIELDS = ['skills', 'commands', 'agents', 'hooks', 'mcpServers'];
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_DEPENDENCIES = 64;
const INVALID_SOURCE = { kind: 'unsupported', type: 'invalid' };
const CATEGORY_ALIASES = {
    code: 'Code',
    coding: 'Code',
    development: 'Code',
    'developer-tools': 'Code',
    design: 'Design & Sites',
    science: 'Science & Healthcare',
    healthcare: 'Science & Healthcare',
};
/**
 * Reads the catalog of a marketplace root. A missing or unparsable catalog
 * fails as a whole; a bad entry only degrades that entry.
 */
export async function readCatalog(root) {
    return parseCatalog(await readCatalogDocument(root));
}
/** @internal Pure parser behind {@link readCatalog}, exported for focused tests. */
export function parseCatalog(document) {
    if (!isRecord(document))
        throw invalid('Marketplace catalog must be a JSON object');
    const name = stringField(document.name);
    if (!name)
        throw invalid('Marketplace catalog has no name');
    if (!Array.isArray(document.plugins))
        throw invalid('Marketplace catalog has no plugin list');
    const diagnostics = [];
    const metadata = recordField(document.metadata);
    const display = recordField(document.interface);
    const pluginRoot = parsePluginRoot(metadata.pluginRoot, diagnostics);
    const catalog = {
        name,
        ...optionalStrings({
            displayName: display.displayName ?? metadata.displayName,
            description: document.description ?? metadata.description ?? display.shortDescription,
        }),
        entries: parseEntries(document.plugins, pluginRoot, diagnostics),
    };
    return { catalog, diagnostics };
}
/** Same key as installed Plugin names: trimmed, NFKC, case-insensitive. */
export function entryNameKey(name) {
    return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
export function findCatalogEntry(catalog, name) {
    const key = entryNameKey(name);
    return catalog.entries.find((entry) => entryNameKey(entry.name) === key);
}
async function readCatalogDocument(root) {
    let canonicalRoot;
    try {
        canonicalRoot = await realpath(root);
    }
    catch {
        throw marketplaceError(MarketplaceErrorCode.MANIFEST_NOT_FOUND, 'Marketplace root is missing');
    }
    for (const relativePath of CATALOG_FILES) {
        const text = await readContainedFile(canonicalRoot, relativePath);
        if (text !== undefined)
            return parseJson(text);
    }
    throw marketplaceError(MarketplaceErrorCode.MANIFEST_NOT_FOUND, 'Marketplace catalog not found');
}
// A catalog must be a regular file inside the root: a symlink could expose an
// unrelated local file as catalog text.
async function readContainedFile(root, relativePath) {
    const file = path.join(root, ...relativePath.split('/'));
    try {
        const stats = await lstat(file);
        if (!stats.isFile() || !isInside(root, await realpath(path.dirname(file))))
            return undefined;
        if (stats.size > MAX_CATALOG_BYTES)
            throw invalid('Marketplace catalog is too large');
        return await readFile(file, 'utf8');
    }
    catch (error) {
        if (error instanceof PluginSystemError)
            throw error;
        return undefined;
    }
}
function parseJson(text) {
    try {
        return JSON.parse(text.replace(/^\uFEFF/u, ''));
    }
    catch {
        throw invalid('Marketplace catalog is not valid JSON');
    }
}
function parsePluginRoot(value, diagnostics) {
    if (typeof value !== 'string')
        return '';
    const normalized = normalizeRepositoryPath(value);
    if (normalized === undefined)
        diagnostics.push({ code: 'PLUGIN_ROOT_INVALID' });
    return normalized ?? '';
}
function parseEntries(plugins, pluginRoot, diagnostics) {
    const entries = [];
    const seen = new Set();
    for (const [index, raw] of plugins.entries()) {
        const entry = parseEntry(raw, pluginRoot);
        if (!entry) {
            diagnostics.push({ code: 'ENTRY_INVALID', index });
            continue;
        }
        // The first entry of a name wins, like the first Plugin of a name at runtime.
        const key = entryNameKey(entry.name);
        if (seen.has(key)) {
            diagnostics.push({ code: 'ENTRY_DUPLICATE', index });
            continue;
        }
        seen.add(key);
        if (entry.source === INVALID_SOURCE)
            diagnostics.push({ code: 'ENTRY_SOURCE_INVALID', index });
        entries.push(entry);
    }
    return entries;
}
function parseEntry(raw, pluginRoot) {
    if (!isRecord(raw))
        return undefined;
    const name = stringField(raw.name);
    // The entry name becomes the Plugin id and its install directory.
    if (!name || !isInstallablePluginName(name))
        return undefined;
    const source = parseEntrySource(raw.source, pluginRoot);
    const unavailableReason = entryUnavailableReason(source, recordField(raw.policy));
    return {
        name,
        source,
        ...optionalStrings({
            version: raw.version,
            displayName: raw.displayName ?? recordField(raw.interface).displayName,
            description: raw.description,
            author: authorName(raw.author),
            homepage: httpUrl(raw.homepage),
        }),
        category: categoryOf(raw.category),
        dependencies: dependencyList(raw.dependencies),
        manifestFields: componentFields(raw),
        strict: raw.strict !== false,
        ...(unavailableReason ? { unavailableReason } : {}),
    };
}
function entryUnavailableReason(source, policy) {
    if (source.kind === 'unsupported')
        return 'UNSUPPORTED_SOURCE';
    return policy.installation === 'NOT_AVAILABLE' ? 'NOT_AVAILABLE' : undefined;
}
function parseEntrySource(value, pluginRoot) {
    if (typeof value === 'string')
        return relativeSource(value, pluginRoot);
    if (!isRecord(value))
        return INVALID_SOURCE;
    const type = stringField(value.source) ?? 'unknown';
    if (type === 'local') {
        return typeof value.path === 'string' ? relativeSource(value.path, pluginRoot) : INVALID_SOURCE;
    }
    if (type === 'github')
        return githubSource(value);
    if (type === 'url' || type === 'git-subdir')
        return urlSource(value, type === 'git-subdir');
    return { kind: 'unsupported', type };
}
function relativeSource(value, pluginRoot) {
    const written = normalizeRepositoryPath(value);
    if (written === undefined)
        return INVALID_SOURCE;
    const joined = [pluginRoot, written].filter(Boolean).join('/');
    // Catalogs disagree on whether `./plugins/x` already includes pluginRoot.
    return joined === written
        ? { kind: 'relative', path: written }
        : { kind: 'relative', path: joined, fallbackPath: written };
}
function githubSource(value) {
    const [owner, repo, ...rest] = (stringField(value.repo) ?? '').split('/');
    const remote = owner && repo && rest.length === 0 ? GitRemote.github(owner, repo) : undefined;
    return remote ? gitSource(remote, value) : INVALID_SOURCE;
}
function urlSource(value, requirePath) {
    const remote = GitRemote.parse(stringField(value.url) ?? '')?.remote;
    if (!remote || (requirePath && typeof value.path !== 'string'))
        return INVALID_SOURCE;
    return gitSource(remote, value);
}
function gitSource(remote, value) {
    const ref = stringField(value.ref);
    const sha = stringField(value.sha);
    const subPath = typeof value.path === 'string' ? normalizeRepositoryPath(value.path) : '';
    const valid = (ref === undefined || isSafeGitRef(ref)) &&
        (sha === undefined || isFullCommitSha(sha)) &&
        subPath !== undefined;
    if (!valid)
        return INVALID_SOURCE;
    return {
        kind: 'git',
        remote,
        ...(ref ? { ref } : {}),
        ...(sha ? { sha: sha.toLowerCase() } : {}),
        ...(subPath ? { subPath } : {}),
    };
}
function categoryOf(value) {
    const key = (stringField(value) ?? '').toLowerCase().replace(/[\s_]+/gu, '-');
    const named = MARKETPLACE_CATEGORY_NAMES.find((category) => category.toLowerCase().replace(/\s+/gu, '-') === key);
    return named ?? CATEGORY_ALIASES[key] ?? 'Other';
}
function dependencyList(value) {
    if (!Array.isArray(value))
        return [];
    const dependencies = value
        .map((item) => stringField(isRecord(item) ? item.name : item))
        .filter((item) => item !== undefined);
    return [...new Set(dependencies)].slice(0, MAX_DEPENDENCIES);
}
function componentFields(raw) {
    return Object.fromEntries(COMPONENT_FIELDS.filter((field) => raw[field] !== undefined).map((field) => [
        field,
        raw[field],
    ]));
}
function authorName(value) {
    return stringField(isRecord(value) ? value.name : value);
}
function httpUrl(value) {
    const text = stringField(value);
    return text && /^https?:\/\//iu.test(text) ? text : undefined;
}
function optionalStrings(fields) {
    const result = {};
    for (const [key, value] of Object.entries(fields)) {
        const text = stringField(value);
        if (text)
            result[key] = text;
    }
    return result;
}
function stringField(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function recordField(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function invalid(message) {
    return marketplaceError(MarketplaceErrorCode.MANIFEST_INVALID, message);
}
//# sourceMappingURL=catalog.js.map