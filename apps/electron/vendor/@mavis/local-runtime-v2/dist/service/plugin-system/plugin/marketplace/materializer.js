import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile, } from 'node:fs/promises';
import path from 'node:path';
import { PluginSystemError } from '../../errors.js';
import { readCompatiblePluginPackage } from '../package/compatibility-reader.js';
import { PLUGIN_PACKAGE_V1_LIMITS } from '../package/package-contract.js';
import { hasSupportedCapability, readImportedPluginPackage } from '../package/package-readers.js';
import { checkout } from '../source/git-checkout.js';
import { normalizeRepositoryPath } from '../source/git-remote.js';
import { COMPATIBLE_PLUGIN_DIRECTORY } from './catalog.js';
import { MarketplaceErrorCode, marketplaceError, normalizeMarketplaceError } from './errors.js';
/** Manifests the package readers recognize besides a root Agent Plugins `plugin.json`. */
const VENDOR_MANIFESTS = [
    '.minimax-plugin/plugin.json',
    `${COMPATIBLE_PLUGIN_DIRECTORY}/plugin.json`,
    '.codex-plugin/plugin.json',
];
const MANIFEST_SPARSE_PATHS = [
    '.minimax-plugin',
    COMPATIBLE_PLUGIN_DIRECTORY,
    '.codex-plugin',
    'plugin.json',
];
const SYNTHESIZED_MANIFEST = [COMPATIBLE_PLUGIN_DIRECTORY, 'plugin.json'];
const MAX_MANIFEST_BYTES = 1024 * 1024;
export async function inspectRelativeEntry(root, entry, source) {
    const location = await locateEntry(root, source);
    if (!location)
        return { assembled: false, unavailableReason: 'SOURCE_MISSING' };
    const manifest = await probeManifest(location.directory);
    // strict:false makes the entry the whole definition; a manifest that also
    // declares components is ambiguous (Claude Code rejects it the same way).
    if (manifest && !entry.strict && hasComponents(entry)) {
        return { location, manifest, assembled: false, unavailableReason: 'MANIFEST_CONFLICT' };
    }
    const assembled = location.relativePath === '' && !manifest?.vendor && declaresSkills(entry);
    return { location, ...(manifest ? { manifest } : {}), assembled };
}
export async function probeManifest(directory) {
    for (const file of VENDOR_MANIFESTS) {
        const probe = await readManifestFile(directory, file, true);
        if (probe)
            return probe;
    }
    return readManifestFile(directory, 'plugin.json', false);
}
export function manifestVersion(probe) {
    const version = probe?.value?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : undefined;
}
/** `dependencies` of a manifest as written: strings, or objects with a `name`. */
export function manifestDependencies(probe) {
    const value = probe?.value?.dependencies;
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => (isRecord(item) ? item.name : item))
        .filter((item) => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim());
}
/** Paths an entry's component fields point at, relative to the entry directory. */
export function declaredComponentPaths(entry) {
    const paths = Object.values(entry.manifestFields).flatMap((value) => (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string'));
    return [
        ...new Set(paths
            .map((item) => normalizeRepositoryPath(item))
            .filter((item) => item !== undefined)),
    ];
}
/**
 * The entry as a compatible-format manifest (the entry is the manifest), named
 * after the entry. A directory that is a single Skill loads as `skills: ["./"]`.
 */
function synthesizeManifest(entry, singleSkill) {
    return {
        name: entry.name,
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.author ? { author: { name: entry.author } } : {}),
        ...(entry.homepage ? { homepage: entry.homepage } : {}),
        ...(entry.dependencies.length > 0 ? { dependencies: [...entry.dependencies] } : {}),
        ...entry.manifestFields,
        ...(singleSkill && entry.manifestFields.skills === undefined ? { skills: ['./'] } : {}),
    };
}
/**
 * Turns catalog entries into packages: owned copies staged under
 * `${dataDir}/v2/plugin-import`, read-only previews, or link inputs.
 */
export class EntryMaterializer {
    dataDir;
    importRoot;
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.importRoot = path.join(dataDir, 'v2', 'plugin-import');
    }
    /** Copies a relative entry out of its marketplace root (never in place). */
    async fromCatalogRoot(entry, state) {
        const location = requireInstallable(state);
        const staging = await this.createStaging();
        try {
            await copyEntry(location.directory, entry, state.assembled, staging.root);
            return await this.prepare(staging.root, entry, state.manifest, staging.discard);
        }
        catch (error) {
            await staging.discard();
            throw normalizeMarketplaceError(error);
        }
    }
    /** Checks out a Git-sourced entry; `version` falls back to the commit. */
    async fromGit(entry, source) {
        let checkedOut;
        try {
            checkedOut = await checkout(source.remote, {
                stagingParent: this.importRoot,
                ...(source.sha ? { sha: source.sha } : { ref: source.ref }),
                subPath: source.subPath,
                sparsePaths: gitSparsePaths(entry, source),
            });
        }
        catch (error) {
            throw normalizeMarketplaceError(error);
        }
        try {
            const manifest = await probeManifest(checkedOut.path);
            if (manifest && !entry.strict && hasComponents(entry))
                throw unavailable('MANIFEST_CONFLICT');
            const assembled = !source.subPath && !manifest?.vendor && declaresSkills(entry);
            let stagingRoot = checkedOut.path;
            if (assembled) {
                stagingRoot = path.join(path.dirname(checkedOut.root), 'plugin');
                await copyEntry(checkedOut.path, entry, true, stagingRoot);
            }
            const prepared = await this.prepare(stagingRoot, entry, manifest, checkedOut.discard);
            return { prepared, commitSha: checkedOut.commitSha };
        }
        catch (error) {
            await checkedOut.discard();
            throw normalizeMarketplaceError(error);
        }
    }
    /** The package as it would install; undefined when it cannot be read. */
    async preview(entry, state) {
        if (!state.location || state.unavailableReason)
            return undefined;
        try {
            if (state.assembled)
                return await this.previewAssembled(entry, state.location);
            return await readInPlace(state.location.directory, entry, state.manifest, this.dataDir);
        }
        catch {
            return undefined;
        }
    }
    /** Link registration for a folder entry; the folder is never written. */
    async linkInput(entry, state) {
        const location = requireInstallable(state);
        if (state.manifest?.vendor)
            return { rootPath: location.directory };
        const manifest = synthesizeManifest(entry, await isSingleSkill(location.directory));
        return { rootPath: location.directory, manifest };
    }
    async previewAssembled(entry, location) {
        const staging = await this.createStaging();
        try {
            await copyEntry(location.directory, entry, true, staging.root);
            await writeSynthesizedManifest(staging.root, entry);
            return await readImportedPluginPackage(staging.root, {
                dataDir: this.dataDir,
                createPluginData: false,
            });
        }
        finally {
            await staging.discard();
        }
    }
    async prepare(stagingRoot, entry, manifest, discard) {
        if (!manifest?.vendor)
            await writeSynthesizedManifest(stagingRoot, entry);
        const plugin = await readImportedPluginPackage(stagingRoot, {
            dataDir: this.dataDir,
            createPluginData: false,
        });
        if (!hasSupportedCapability(plugin)) {
            throw new PluginSystemError('PLUGIN_NO_SUPPORTED_CAPABILITY', 'Plugin contains no valid App, Skill, MCP, Hook, Agent, or Mini App capability');
        }
        return { stagingRoot, plugin, discard };
    }
    async createStaging() {
        await mkdir(this.importRoot, { recursive: true });
        const temporary = await mkdtemp(path.join(this.importRoot, 'marketplace-'));
        let active = true;
        return {
            root: path.join(temporary, 'plugin'),
            discard: async () => {
                if (!active)
                    return;
                active = false;
                await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
            },
        };
    }
}
async function readInPlace(directory, entry, manifest, dataDir) {
    if (manifest) {
        try {
            return await readImportedPluginPackage(directory, { dataDir, createPluginData: false });
        }
        catch (error) {
            // A root plugin.json the Agent Plugins reader rejects still installs with the entry manifest.
            if (manifest.vendor)
                throw error;
        }
    }
    return readCompatiblePluginPackage(directory, {
        declaredManifest: synthesizeManifest(entry, await isSingleSkill(directory)),
    });
}
async function writeSynthesizedManifest(root, entry) {
    const manifest = synthesizeManifest(entry, await isSingleSkill(root));
    const file = path.join(root, ...SYNTHESIZED_MANIFEST);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
async function locateEntry(root, source) {
    let canonicalRoot;
    try {
        canonicalRoot = await realpath(root);
    }
    catch {
        return undefined;
    }
    for (const candidate of [source.path, source.fallbackPath]) {
        if (candidate === undefined)
            continue;
        const directory = await containedDirectory(canonicalRoot, candidate);
        if (directory)
            return { directory, relativePath: candidate };
    }
    return undefined;
}
// realpath first: a symlinked directory must not reach outside the marketplace.
async function containedDirectory(root, relativePath) {
    try {
        const resolved = await realpath(path.join(root, ...relativePath.split('/').filter(Boolean)));
        return isInside(root, resolved) && (await stat(resolved)).isDirectory() ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
async function readManifestFile(directory, relativePath, vendor) {
    const file = path.join(directory, ...relativePath.split('/'));
    try {
        const stats = await lstat(file);
        if (!stats.isFile())
            return undefined;
        // A symlinked manifest directory must not expose a file outside the Plugin.
        if (!isInside(await realpath(directory), await realpath(file)))
            return undefined;
        if (stats.size > MAX_MANIFEST_BYTES)
            return { vendor };
        const value = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
        return isRecord(value) ? { vendor, value } : { vendor };
    }
    catch (error) {
        return isMissing(error) ? undefined : { vendor };
    }
}
async function copyEntry(source, entry, assembled, target) {
    const budget = { files: 0, bytes: 0 };
    const paths = declaredComponentPaths(entry);
    if (!assembled || paths.includes('')) {
        await copyTree(source, target, budget);
        return;
    }
    await mkdir(target, { recursive: true });
    for (const relativePath of paths) {
        await copyDeclaredPath(source, relativePath, target, budget);
    }
}
async function copyDeclaredPath(root, relativePath, target, budget) {
    const segments = relativePath.split('/');
    const from = path.join(root, ...segments);
    try {
        if (!isInside(root, await realpath(from)))
            return;
    }
    catch {
        // A missing declared path is reported by the package reader.
        return;
    }
    const to = path.join(target, ...segments);
    const stats = await lstat(from);
    if (stats.isDirectory())
        await copyTree(from, to, budget);
    else if (stats.isFile()) {
        await mkdir(path.dirname(to), { recursive: true });
        await copyBoundedFile(from, to, stats.size, budget);
    }
}
// Regular files and directories only: symlinks and special files are skipped,
// as in GitHub archive imports, and Git metadata never enters a package.
async function copyTree(source, target, budget) {
    await mkdir(target, { recursive: true });
    for (const child of await readdir(source, { withFileTypes: true })) {
        if (child.name === '.git')
            continue;
        const from = path.join(source, child.name);
        const to = path.join(target, child.name);
        if (child.isDirectory())
            await copyTree(from, to, budget);
        else if (child.isFile())
            await copyBoundedFile(from, to, (await lstat(from)).size, budget);
    }
}
async function copyBoundedFile(from, to, size, budget) {
    budget.files += 1;
    budget.bytes += size;
    if (size > PLUGIN_PACKAGE_V1_LIMITS.maxFileBytes) {
        throw new PluginSystemError('FILE_TOO_LARGE', 'Plugin file exceeds the file limit');
    }
    if (budget.files > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
        throw new PluginSystemError('TOO_MANY_FILES', 'Plugin contains too many files');
    }
    if (budget.bytes > PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes) {
        throw new PluginSystemError('TOTAL_SIZE_LIMIT', 'Plugin exceeds 64 MiB');
    }
    await copyFile(from, to, constants.COPYFILE_EXCL);
}
function gitSparsePaths(entry, source) {
    if (source.subPath)
        return [source.subPath];
    const paths = declaredComponentPaths(entry);
    if (!declaresSkills(entry) || paths.includes(''))
        return undefined;
    return [...MANIFEST_SPARSE_PATHS, ...paths];
}
async function isSingleSkill(directory) {
    const [skillFile, skillsDirectory] = await Promise.all([
        statOrUndefined(path.join(directory, 'SKILL.md')),
        statOrUndefined(path.join(directory, 'skills')),
    ]);
    return Boolean(skillFile?.isFile()) && !skillsDirectory?.isDirectory();
}
async function statOrUndefined(target) {
    try {
        return await lstat(target);
    }
    catch {
        return undefined;
    }
}
function requireInstallable(state) {
    if (state.unavailableReason)
        throw unavailable(state.unavailableReason);
    if (!state.location)
        throw unavailable('SOURCE_MISSING');
    return state.location;
}
function unavailable(reason) {
    return marketplaceError(MarketplaceErrorCode.ENTRY_UNAVAILABLE, 'Entry cannot be installed', reason);
}
function hasComponents(entry) {
    return Object.keys(entry.manifestFields).length > 0;
}
function declaresSkills(entry) {
    return entry.manifestFields.skills !== undefined;
}
function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function isMissing(error) {
    return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=materializer.js.map