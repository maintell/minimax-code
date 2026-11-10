import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isBuiltInPluginMarketplace, isValidPluginMarketplaceName } from '@mavis/shared';
import { checkout, resolveRoute } from '../source/git-checkout.js';
import { GitRemote, isFullCommitSha, isSafeGitRef, normalizeRepositoryPath, splitRouteTail, } from '../source/git-remote.js';
import { CATALOG_DIRECTORIES, readCatalog } from './catalog.js';
import { errorCodeOf, MarketplaceErrorCode, marketplaceError, normalizeMarketplaceError, } from './errors.js';
import { checkMarketplaceName } from './marketplace-name.js';
const SNAPSHOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/**
 * Parses what a user typed: GitHub `owner/repo[@ref]`, an HTTPS / ssh /
 * scp-like Git URL or browser page, or an absolute (or `~`) folder path.
 * A browser route whose ref may contain `/` needs `resolveMarketplaceSource`.
 *
 * @internal
 */
export function parseMarketplaceSource(input) {
    const value = input.source.trim();
    const parsed = GitRemote.parse(value);
    if (parsed) {
        const routeRef = parsed.route ? splitRouteTail(parsed.route)?.ref : undefined;
        return gitMarketplaceSource(parsed.remote, input.ref?.trim() || parsed.ref || routeRef, input);
    }
    const folder = expandHome(value);
    if (!folder || !path.isAbsolute(folder)) {
        throw sourceInvalid('Source must be a Git repository or an absolute folder path');
    }
    return { kind: 'directory', path: path.resolve(folder) };
}
/**
 * `parseMarketplaceSource`, plus the ref of a browser tree / blob page
 * (`…/-/tree/release/v2`), read from the remote when the ref may contain `/`.
 * An explicit ref wins; a path in the page is ignored because the catalog sits
 * at the repository root.
 */
export async function resolveMarketplaceSource(input) {
    const parsed = GitRemote.parse(input.source.trim());
    if (!parsed?.route || input.ref?.trim())
        return parseMarketplaceSource(input);
    const { ref } = await resolveRoute(parsed.remote, parsed.route);
    return gitMarketplaceSource(parsed.remote, ref, input);
}
function gitMarketplaceSource(remote, ref, input) {
    if (ref !== undefined && !isSafeGitRef(ref) && !isFullCommitSha(ref)) {
        throw sourceInvalid('Git ref is not a valid branch, tag, or commit');
    }
    const sparsePaths = normalizeSparsePaths(input.sparsePaths ?? []);
    return {
        kind: 'git',
        remote,
        ...(ref ? { ref } : {}),
        ...(sparsePaths.length > 0 ? { sparsePaths } : {}),
    };
}
/** Remote of a stored Git marketplace; undefined for folders or an unreadable record. */
function storedRemote(record) {
    return record.source.kind === 'git' ? GitRemote.parse(record.source.url)?.remote : undefined;
}
/**
 * `${dataDir}/v2/plugin-marketplaces/`: `registry.json` and one immutable
 * snapshot per Git marketplace under `snapshots/<id>`. A refresh writes a new
 * snapshot and swaps the registry pointer, so a failed refresh leaves the
 * previous catalog in place. Callers serialize mutations.
 */
export class MarketplaceRegistry {
    options;
    stateDir;
    registryFile;
    snapshotsDir;
    stagingDir;
    constructor(options) {
        this.options = options;
        this.stateDir = path.join(options.dataDir, 'v2', 'plugin-marketplaces');
        this.registryFile = path.join(this.stateDir, 'registry.json');
        this.snapshotsDir = path.join(this.stateDir, 'snapshots');
        this.stagingDir = path.join(this.stateDir, 'staging');
    }
    /** Added marketplaces ordered by name; malformed records are skipped. */
    async list() {
        const document = await readJsonFile(this.registryFile);
        const items = isRecord(document) && Array.isArray(document.marketplaces) ? document.marketplaces : [];
        const records = [];
        for (const item of items) {
            const record = parseStoredMarketplace(item);
            if (record && !records.some((existing) => existing.name === record.name))
                records.push(record);
        }
        return records.sort((left, right) => left.name.localeCompare(right.name));
    }
    async find(name) {
        return (await this.list()).find((record) => record.name === name);
    }
    /** Catalog root: the snapshot of a Git marketplace or the folder itself. */
    rootOf(record) {
        if (record.source.kind === 'directory')
            return record.source.path;
        return record.snapshot ? path.join(this.snapshotsDir, record.snapshot) : undefined;
    }
    /**
     * Adds a source. The same source again returns the existing record with
     * `alreadyAdded` and touches nothing.
     */
    async add(source) {
        const records = await this.list();
        const resolved = source.kind === 'directory' ? await canonicalFolder(source) : source;
        const existing = records.find((record) => sameSource(record, resolved));
        if (existing)
            return { record: existing, alreadyAdded: true };
        const record = resolved.kind === 'directory'
            ? await this.addFolder(resolved.path, records)
            : await this.addGit(resolved, records);
        return { record, alreadyAdded: false };
    }
    /**
     * Re-reads one catalog. Failures are recorded as `lastErrorCode` and keep
     * the previous snapshot; only an unknown name throws.
     */
    async refresh(name) {
        const records = await this.list();
        const record = records.find((item) => item.name === name);
        if (!record)
            throw notFound();
        const next = await this.resync(record);
        await this.write(records.map((item) => (item.name === name ? next : item)));
        if (record.snapshot && record.snapshot !== next.snapshot)
            await this.removeSnapshot(record.snapshot);
        return next;
    }
    async setAutoUpdate(name, autoUpdate) {
        const records = await this.list();
        const record = records.find((item) => item.name === name);
        if (!record)
            throw notFound();
        // Folder marketplaces load in place; there is nothing to sync.
        const next = { ...record, autoUpdate: record.source.kind === 'git' && autoUpdate };
        await this.write(records.map((item) => (item.name === name ? next : item)));
        return next;
    }
    async forget(name) {
        const records = await this.list();
        const record = records.find((item) => item.name === name);
        if (!record)
            return;
        await this.write(records.filter((item) => item.name !== name));
        if (record.snapshot)
            await this.removeSnapshot(record.snapshot);
    }
    /** Deletes snapshots no record points to and abandoned clones. */
    async collectGarbage() {
        const referenced = new Set((await this.list()).map((record) => record.snapshot));
        for (const name of await listDirectory(this.snapshotsDir)) {
            if (!referenced.has(name))
                await this.removeSnapshot(name);
        }
        await rm(this.stagingDir, { recursive: true, force: true, maxRetries: 3 });
    }
    async addFolder(folder, records) {
        const { catalog } = await readCatalog(folder);
        assertNameAvailable(catalog, undefined, records);
        const record = {
            name: catalog.name,
            source: { kind: 'directory', path: folder },
            autoUpdate: false,
            lastSyncedAtMs: this.options.now(),
        };
        await this.write([...records, record]);
        return record;
    }
    async addGit(source, records) {
        const snapshot = await this.createSnapshot(source, (catalog) => assertNameAvailable(catalog, source.remote, records));
        const record = {
            name: snapshot.catalog.name,
            source: {
                kind: 'git',
                url: source.remote.url,
                ...(source.ref ? { ref: source.ref } : {}),
                ...(source.sparsePaths ? { sparsePaths: source.sparsePaths } : {}),
            },
            // Adding a marketplace already trusts its Plugins; syncing it by default keeps installs
            // current. The automatic path never overwrites local edits, and users can opt out.
            autoUpdate: true,
            snapshot: snapshot.id,
            lastSyncedAtMs: this.options.now(),
        };
        try {
            await this.write([...records, record]);
        }
        catch (error) {
            await this.removeSnapshot(snapshot.id);
            throw error;
        }
        return record;
    }
    async resync(record) {
        try {
            if (record.source.kind === 'directory') {
                await readCatalog(record.source.path);
                return synced(record, this.options.now(), undefined);
            }
            const remote = storedRemote(record);
            if (!remote)
                throw sourceInvalid('Stored Git source cannot be parsed');
            const { ref, sparsePaths } = record.source;
            // The registered name stays: renaming a catalog upstream must not move
            // installed Plugins to another identity.
            const snapshot = await this.createSnapshot({ kind: 'git', remote, ref, sparsePaths }, () => { });
            return synced(record, this.options.now(), snapshot.id);
        }
        catch (error) {
            return { ...record, lastErrorCode: errorCodeOf(error) };
        }
    }
    // Clone into staging, validate the catalog, then rename into place: an
    // invalid source never leaves a snapshot behind.
    async createSnapshot(source, validate) {
        let checkedOut;
        try {
            checkedOut = await checkout(source.remote, {
                stagingParent: this.stagingDir,
                ref: source.ref,
                depth: 1,
                sparsePaths: source.sparsePaths
                    ? [...CATALOG_DIRECTORIES, ...source.sparsePaths]
                    : undefined,
                keepMetadata: true,
            });
        }
        catch (error) {
            throw normalizeMarketplaceError(error);
        }
        try {
            const { catalog } = await readCatalog(checkedOut.root);
            validate(catalog);
            const id = randomUUID();
            await mkdir(this.snapshotsDir, { recursive: true });
            await rename(checkedOut.root, path.join(this.snapshotsDir, id));
            return { id, catalog };
        }
        finally {
            await checkedOut.discard();
        }
    }
    async removeSnapshot(id) {
        if (!SNAPSHOT_ID.test(id))
            return;
        await rm(path.join(this.snapshotsDir, id), { recursive: true, force: true, maxRetries: 3 });
    }
    async write(records) {
        await writeJsonFile(this.registryFile, { version: 1, marketplaces: records });
    }
}
/** Atomic replace: readers see the previous or the next file, never a partial one. */
export async function writeJsonFile(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${String(process.pid)}-${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, file);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
/** Missing or unparsable state reads as undefined; callers fall back to empty state. */
export async function readJsonFile(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function assertNameAvailable(catalog, gitSource, records) {
    const violation = checkMarketplaceName(catalog.name, gitSource);
    if (violation === 'RESERVED') {
        throw marketplaceError(MarketplaceErrorCode.NAME_RESERVED, 'Marketplace name is reserved');
    }
    if (violation === 'INVALID') {
        throw marketplaceError(MarketplaceErrorCode.NAME_INVALID, 'Marketplace name is invalid');
    }
    if (records.some((record) => record.name === catalog.name)) {
        throw marketplaceError(MarketplaceErrorCode.NAME_TAKEN, 'Marketplace name is already added');
    }
}
function sameSource(record, source) {
    if (source.kind === 'directory') {
        return record.source.kind === 'directory' && record.source.path === source.path;
    }
    const remote = storedRemote(record);
    return (record.source.kind === 'git' &&
        remote?.identity() === source.remote.identity() &&
        (record.source.ref ?? '') === (source.ref ?? ''));
}
async function canonicalFolder(source) {
    try {
        const folder = await realpath(source.path);
        if ((await stat(folder)).isDirectory())
            return { kind: 'directory', path: folder };
    }
    catch {
        // Reported below with one stable code.
    }
    throw sourceInvalid('Marketplace folder does not exist');
}
function synced(record, now, snapshot) {
    const nextSnapshot = snapshot ?? record.snapshot;
    return {
        name: record.name,
        source: record.source,
        autoUpdate: record.autoUpdate,
        ...(nextSnapshot ? { snapshot: nextSnapshot } : {}),
        lastSyncedAtMs: now,
    };
}
function parseStoredMarketplace(value) {
    if (!isRecord(value) || typeof value.name !== 'string')
        return undefined;
    if (!isValidPluginMarketplaceName(value.name) || isBuiltInPluginMarketplace(value.name)) {
        return undefined;
    }
    const source = parseStoredSource(value.source);
    if (!source)
        return undefined;
    return {
        name: value.name,
        source,
        autoUpdate: source.kind === 'git' && value.autoUpdate === true,
        ...storedSyncState(value),
    };
}
function storedSyncState(value) {
    return {
        ...(typeof value.snapshot === 'string' && SNAPSHOT_ID.test(value.snapshot)
            ? { snapshot: value.snapshot }
            : {}),
        ...(typeof value.lastSyncedAtMs === 'number' ? { lastSyncedAtMs: value.lastSyncedAtMs } : {}),
        ...(typeof value.lastErrorCode === 'string' ? { lastErrorCode: value.lastErrorCode } : {}),
    };
}
function parseStoredSource(value) {
    if (!isRecord(value))
        return undefined;
    if (value.kind === 'directory') {
        return typeof value.path === 'string' && path.isAbsolute(value.path)
            ? { kind: 'directory', path: value.path }
            : undefined;
    }
    if (value.kind !== 'git' || typeof value.url !== 'string')
        return undefined;
    const sparsePaths = Array.isArray(value.sparsePaths)
        ? value.sparsePaths.filter((item) => typeof item === 'string')
        : [];
    return {
        kind: 'git',
        url: value.url,
        ...(typeof value.ref === 'string' ? { ref: value.ref } : {}),
        ...(sparsePaths.length > 0 ? { sparsePaths } : {}),
    };
}
function normalizeSparsePaths(values) {
    const paths = values.map((value) => normalizeRepositoryPath(value));
    if (paths.some((value) => value === undefined)) {
        throw sourceInvalid('Sparse paths must stay inside the repository');
    }
    return [...new Set(paths.filter((value) => Boolean(value)))];
}
function expandHome(value) {
    if (value === '~')
        return os.homedir();
    return /^~[\\/]/u.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
}
async function listDirectory(directory) {
    try {
        return await readdir(directory);
    }
    catch {
        return [];
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sourceInvalid(message) {
    return marketplaceError(MarketplaceErrorCode.SOURCE_INVALID, message);
}
function notFound() {
    return marketplaceError(MarketplaceErrorCode.NOT_FOUND, 'Marketplace is not added');
}
//# sourceMappingURL=registry.js.map