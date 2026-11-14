import { resolveBunnyHomeDir } from '@mavis/shared/local-runtime-paths';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GLOBAL_SCOPE_KEY, MemoryScopeMutationCoordinator } from '../../memory-system/index.js';
import { MEMORY_STATE_BROKEN } from '../../coordinator-text/index.js';
import { ARCHIVE_DISK_NAME, isDailyDirectory, MAIN_MEMORY_DISK_NAME, memoryDiskName, memoryLogicalName, } from './disk-layout.js';
import { appendArchive, appendDaily, archivedEntryNumbers, dateKey, EMPTY_FORGOTTEN, EMPTY_MEMORY, fitMemory, memoryInjection, BunnyMemoryFormatError, overMemoryLimit, parseForgotten, oneLine, parseMemory, serializeForgotten, serializeMemory, validateFiles, } from './format.js';
import { BunnyMemoryChangedError, BunnyMemoryRuleError, BunnyMemoryStateError, assertEntriesFit, } from './validation.js';
const initialState = () => ({
    baseline: EMPTY_MEMORY,
    highWater: 0,
    lastLintMs: 0,
    manualEdits: '',
});
const STATE_FILE = '.memory-state.json';
function parseState(text) {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null)
        throw new Error('Invalid memory state shape');
    const state = value;
    const valid = typeof state.baseline === 'string' &&
        typeof state.manualEdits === 'string' &&
        Number.isSafeInteger(state.highWater) &&
        Number.isSafeInteger(state.lastLintMs) &&
        ['undefined', 'string'].includes(typeof state.idleJobId);
    if (!valid)
        throw new Error('Invalid memory state shape');
    return value;
}
/**
 * Highest entry number used by the main memory, a forget rule or an evicted entry, so IDs are
 * never reused. A state repair can run while forgotten.md itself is invalid: its entry lines
 * still count.
 */
function usedEntryNumber(main, forgotten, archive) {
    let rules;
    try {
        rules = parseForgotten(forgotten);
    }
    catch {
        rules = [...forgotten.matchAll(/^[ \t]*- \[(m-\d+)\] /gmu)].map((match) => ({ id: match[1] }));
    }
    return Math.max(0, ...[...parseMemory(main), ...rules].map((entry) => Number(entry.id.slice(2))), ...archivedEntryNumbers(archive));
}
export const fileDigest = (files) => createHash('sha256')
    .update(JSON.stringify(Object.entries(files).sort()))
    .digest('hex');
function validateRemember(input, hasEntry) {
    if (!input.content?.trim() || (!hasEntry && !input.type) || !input.basis)
        throw new Error('content, type (add), and basis are required');
}
async function assertNotSymlink(path) {
    if ((await lstat(path)).isSymbolicLink())
        throw new Error('Memory symlink rejected');
}
const isForgotten = (content, forgotten) => parseForgotten(forgotten).some((rule) => oneLine(rule.content) === oneLine(content));
function assertNotForgotten(content, forgotten) {
    if (isForgotten(content, forgotten))
        throw new Error('Remove the forgotten rule before remembering this content again');
}
/** Drops the forget rules a user explicitly restored from the settings editor. */
function withoutForgottenRules(forgotten, restored) {
    return serializeForgotten(parseForgotten(forgotten).filter((rule) => !restored.has(oneLine(rule.content))));
}
/** The Bunny memory directory; only this store writes inside it. */
export function bunnyMemoryRoot(dataDir) {
    return join(resolveBunnyHomeDir(dataDir), 'memory');
}
/** One lock for remember, publication, settings saves, and external edit reconciliation. */
export class BunnyMemoryFileStore {
    dataDir;
    nowMs;
    warn;
    root;
    lock = new MemoryScopeMutationCoordinator();
    constructor(dataDir, nowMs = Date.now, warn = () => undefined) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
        this.warn = warn;
        this.root = bunnyMemoryRoot(dataDir);
    }
    withLock(run) {
        return this.lock.withScopeMutation(GLOBAL_SCOPE_KEY, run);
    }
    async initialize() {
        await mkdir(dirname(this.root), { recursive: true });
        await assertNotSymlink(dirname(this.root));
        try {
            await assertNotSymlink(this.root);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            try {
                await rename(`${this.root}.previous`, this.root);
            }
            catch (recovery) {
                if (recovery.code !== 'ENOENT')
                    throw recovery;
            }
        }
        await mkdir(this.root, { recursive: true });
        await assertNotSymlink(this.root);
        await mkdir(join(this.root, 'daily'), { recursive: true });
        if ((await lstat(join(this.root, 'daily'))).isSymbolicLink())
            throw new Error('Memory symlink rejected');
        await this.createMissingFiles();
    }
    /** Creates the empty main memory and forget list when they are missing. */
    async createMissingFiles() {
        const initial = { 'forgotten.md': EMPTY_FORGOTTEN, [MAIN_MEMORY_DISK_NAME]: EMPTY_MEMORY };
        for (const [name, content] of Object.entries(initial)) {
            try {
                await writeFile(join(this.root, name), content, { flag: 'wx' });
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
        }
    }
    /** Memory files by logical name. */
    async read() {
        await this.initialize();
        const files = {};
        for (const disk of await this.memoryDiskFiles(''))
            files[memoryLogicalName(disk)] = await readFile(join(this.root, disk), 'utf8');
        validateFiles(files);
        return files;
    }
    /** Disk paths of memory files below `prefix`, descending only into daily directories. */
    async memoryDiskFiles(prefix) {
        if ((await lstat(join(this.root, prefix))).isSymbolicLink())
            throw new Error('Memory symlink rejected');
        const found = [];
        for (const entry of await readdir(join(this.root, prefix), { withFileTypes: true })) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink())
                throw new Error('Memory symlink rejected');
            if (entry.isDirectory() && isDailyDirectory(name))
                found.push(...(await this.memoryDiskFiles(name)));
            else if (entry.isFile() && memoryLogicalName(name))
                found.push(name);
        }
        return found;
    }
    async state() {
        let text;
        try {
            text = await readFile(join(resolveBunnyHomeDir(this.dataDir), STATE_FILE), 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return initialState();
            throw error;
        }
        try {
            return parseState(text);
        }
        catch (error) {
            throw new BunnyMemoryStateError(MEMORY_STATE_BROKEN, error);
        }
    }
    /**
     * Settings-save repair of a damaged state file: the damaged bytes are kept in
     * `memory-invalid/`, and the state restarts from the memory on disk. A valid
     * MEMORY.md becomes the baseline, so the save that follows is still labeled
     * against it; otherwise the saved MEMORY.md is. IDs stay unique because the
     * high-water mark covers every ID in use, including forget rules.
     */
    async repairDamagedState(saving) {
        try {
            await this.state();
            return;
        }
        catch (error) {
            if (!(error instanceof BunnyMemoryStateError))
                throw error;
        }
        const path = join(resolveBunnyHomeDir(this.dataDir), STATE_FILE);
        const dir = join(dirname(this.root), 'memory-invalid');
        await mkdir(dir, { recursive: true });
        await assertNotSymlink(dir);
        await assertNotSymlink(path);
        await writeFile(join(dir, `${this.nowMs()}-${STATE_FILE}`), await readFile(path));
        let files;
        try {
            files = await this.read();
        }
        catch (error) {
            if (!(error instanceof BunnyMemoryFormatError))
                throw error;
        }
        const baseline = files?.['MEMORY.md'] ?? (saving.name === 'MEMORY.md' ? saving.content : EMPTY_MEMORY);
        const forgotten = files?.['forgotten.md'] ?? (await this.readForgottenText());
        const highWater = usedEntryNumber(baseline, forgotten, await this.readArchive());
        await this.saveState({ ...initialState(), baseline, highWater });
    }
    /** Entries the limit moved out of the main memory, as text; empty before the first eviction. */
    async readArchive() {
        const path = join(this.root, ARCHIVE_DISK_NAME);
        try {
            await assertNotSymlink(path);
            return await readFile(path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return '';
            throw error;
        }
    }
    /** The raw forget rules of an otherwise invalid memory, for the ID high-water mark only. */
    async readForgottenText() {
        try {
            return await readFile(join(this.root, 'forgotten.md'), 'utf8');
        }
        catch {
            return '';
        }
    }
    async saveState(state) {
        const path = join(resolveBunnyHomeDir(this.dataDir), STATE_FILE);
        const temp = `${path}.${randomUUID()}`;
        await writeFile(temp, JSON.stringify(state));
        await rename(temp, path);
    }
    async reconcile(origin = 'direct') {
        const files = await this.read();
        const observedDigest = fileDigest(files);
        const state = await this.state();
        if (files['MEMORY.md'] === state.baseline)
            return files;
        const before = parseMemory(state.baseline);
        const parsed = parseMemory(files['MEMORY.md']);
        const { entries, restored } = this.absorbEdits({ before, parsed, forgotten: files['forgotten.md'] }, state, origin);
        // An entry whose content survives under another ID was moved, not deleted.
        const deleted = before.filter((old) => !parsed.some((current) => current.id === old.id || current.content === old.content));
        if (deleted.length)
            files['forgotten.md'] = this.withForgotten(files['forgotten.md'], deleted);
        if (restored.size)
            files['forgotten.md'] = withoutForgottenRules(files['forgotten.md'], restored);
        files['MEMORY.md'] = serializeMemory(entries);
        await this.publish(files, observedDigest, state);
        return files;
    }
    /** Keeps unchanged entries, drops direct resurrections and labels every edit by origin. */
    absorbEdits(edit, state, origin) {
        const { before, parsed, forgotten } = edit;
        const restored = new Set();
        let lastNumber = Math.max(state.highWater, ...parsed.map((entry) => Number(entry.id.slice(2))));
        const entries = [];
        for (const entry of parsed) {
            const previous = before.find((old) => old.id === entry.id);
            if (previous?.content === entry.content && previous.example === entry.example) {
                entries.push(entry);
                continue;
            }
            if (isForgotten(entry.content, forgotten)) {
                // A direct write cannot resurrect a deleted memory; a settings save is an explicit restore.
                if (origin !== 'settings')
                    continue;
                restored.add(oneLine(entry.content));
            }
            if (!previous && Number(entry.id.slice(2)) <= state.highWater)
                entry.id = `m-${String(++lastNumber).padStart(2, '0')}`;
            this.labelEdit(entry, state, origin);
            entries.push(entry);
        }
        return { entries, restored };
    }
    labelEdit(entry, state, origin) {
        entry.updated = dateKey(this.nowMs());
        if (origin === 'settings') {
            entry.basis = '用户确认';
            state.manualEdits += `\n${JSON.stringify(entry)}`;
        }
        else {
            // Unverified provenance: lint and the user decide, and it is not a manual edit to keep.
            entry.basis = 'AI 推断';
            entry.status = '待确认';
        }
    }
    /**
     * Publishes checked files. A main memory over the limit loses its oldest entries first, after
     * the writer's own checks passed (spec 3.2): they go to the archive with the time they left,
     * and `files` holds the published main memory afterwards.
     */
    async publish(files, expectedDigest, state) {
        validateFiles(files);
        const nextState = state ?? (await this.state());
        const previousIds = new Set(parseMemory(nextState.baseline).map((entry) => entry.id));
        const written = parseMemory(files['MEMORY.md']);
        if (written.some((entry) => !previousIds.has(entry.id) && Number(entry.id.slice(2)) <= nextState.highWater))
            throw new BunnyMemoryRuleError('Memory IDs cannot be reused');
        if (fileDigest(await this.read()) !== expectedDigest)
            throw new BunnyMemoryChangedError();
        const fitted = fitWritten(files['MEMORY.md'], written);
        files['MEMORY.md'] = fitted.text;
        const archive = await this.readArchive();
        const next = `${this.root}.next-${randomUUID()}`;
        const backup = `${this.root}.previous`;
        let published = false;
        await mkdir(join(next, 'daily'), { recursive: true });
        try {
            for (const [name, text] of Object.entries(files)) {
                const path = join(next, memoryDiskName(name));
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, text);
            }
            await this.writeArchive(next, archive, fitted.evicted);
            // Re-check immediately before publication; any concurrent edit wins over this publication.
            if (fileDigest(await this.read()) !== expectedDigest)
                throw new BunnyMemoryChangedError();
            await rm(backup, { recursive: true, force: true });
            await rename(this.root, backup);
            try {
                await rename(next, this.root);
                published = true;
            }
            catch (error) {
                await rename(backup, this.root);
                throw error;
            }
            nextState.baseline = files['MEMORY.md'] ?? EMPTY_MEMORY;
            // Evicted IDs count too: an entry evicted on the write that added it is never reused.
            nextState.highWater = Math.max(nextState.highWater, ...written.map((entry) => Number(entry.id.slice(2))));
            await this.saveState(nextState);
        }
        finally {
            await rm(next, { recursive: true, force: true });
            if (published)
                await rm(backup, { recursive: true, force: true });
        }
    }
    /** The archive is not a memory file: it is carried over, and grows only by evictions. */
    async writeArchive(dir, archive, evicted) {
        if (!archive && !evicted.length)
            return;
        await writeFile(join(dir, ARCHIVE_DISK_NAME), evicted.length ? appendArchive(archive, evicted, this.nowMs()) : archive);
    }
    /**
     * Runs a replacement of the memory directory (Bunny reset, restore from a backup) under the
     * store lock. A restored main memory over the limit is evicted like any other write; a
     * replacement that left no main memory, or an unreadable one, is left as it is.
     */
    withReplacement(run) {
        return this.withLock(async () => {
            const result = await run();
            try {
                await lstat(join(this.root, MAIN_MEMORY_DISK_NAME));
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return result;
                throw error;
            }
            try {
                const files = await this.reconcile();
                if (overMemoryLimit(files['MEMORY.md']))
                    await this.publish(files, fileDigest(files));
            }
            catch (error) {
                // The replacement itself is done; damaged memory is repaired from settings.
                this.warn(error);
            }
            return result;
        });
    }
    /** The forget list with these main-memory entries added, deleted today. */
    withForgotten(forgotten, entries) {
        const deletedOn = dateKey(this.nowMs());
        return serializeForgotten([
            ...parseForgotten(forgotten),
            ...entries.map(({ id, content, sources }) => ({ id, content, sources, deletedOn })),
        ]);
    }
    /**
     * Prompt assembly degrades to no memory instead of failing every Bunny turn;
     * `unreadable` hears when that happened.
     */
    async renderBunnyMemory(unreadable) {
        try {
            return await this.withLock(async () => memoryInjection(parseMemory((await this.reconcile())['MEMORY.md'])));
        }
        catch (error) {
            this.warn(error);
            unreadable?.(error);
            return '';
        }
    }
    /** Reconciles valid files; reports invalid content as undefined so a repair can proceed. */
    async reconcileIfValid(origin) {
        try {
            return await this.reconcile(origin);
        }
        catch (error) {
            if (error instanceof BunnyMemoryFormatError)
                return undefined;
            throw error;
        }
    }
    /** Keeps the bytes a repair replaces, outside the published memory directory. */
    async keepInvalidFile(name) {
        const disk = memoryDiskName(name);
        const path = join(this.root, disk);
        let text;
        try {
            await assertNotSymlink(path);
            text = await readFile(path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        try {
            validateFiles({ [name]: text });
            return;
        }
        catch (error) {
            if (!(error instanceof BunnyMemoryFormatError))
                throw error;
        }
        const dir = join(dirname(this.root), 'memory-invalid');
        await mkdir(dir, { recursive: true });
        await assertNotSymlink(dir);
        await writeFile(join(dir, `${this.nowMs()}-${disk.replaceAll('/', '-')}`), text);
    }
    async remember(input, source) {
        return this.withLock(async () => {
            const files = await this.reconcile();
            const digest = fileDigest(files);
            const entries = parseMemory(files['MEMORY.md']);
            const date = dateKey(this.nowMs());
            let entry = entries.find((value) => value.id === input.entry_id);
            if (input.action !== 'add' && !entry)
                throw new Error('Memory entry not found');
            if (input.action === 'forget') {
                files['forgotten.md'] = this.withForgotten(files['forgotten.md'], [entry]);
                entries.splice(entries.indexOf(entry), 1);
            }
            else {
                validateRemember(input, Boolean(entry));
                assertNotForgotten(input.content, files['forgotten.md']);
                const duplicate = entries.find((value) => value.id !== entry?.id && value.content === oneLine(input.content));
                if (duplicate)
                    return { entry: duplicate, duplicate: true };
                if (input.action === 'add') {
                    const state = await this.state();
                    entry = {
                        id: `m-${String(state.highWater + 1).padStart(2, '0')}`,
                        type: input.type,
                        content: '',
                        basis: input.basis,
                        sources: [],
                        status: '有效',
                        first: date,
                        updated: date,
                    };
                    entries.push(entry);
                }
                entry.content = oneLine(input.content);
                entry.example = input.example === undefined ? entry.example : oneLine(input.example);
                entry.basis = input.basis;
                // The user's own words settle an entry that was waiting for confirmation.
                entry.status = '有效';
                entry.updated = date;
                entry.sources = [...new Set([...entry.sources, source])];
                const daily = files[`daily/${date}.md`] ?? '';
                const nextId = Math.max(0, ...[...daily.matchAll(/\[d-\d{4}-(\d+)\]/gu)].map((match) => Number(match[1]))) + 1;
                appendDaily(files, date, `- [d-${date.slice(5).replace('-', '')}-${String(nextId).padStart(2, '0')}] ${entry.type} · ${entry.basis} · 支持 ${entry.id}\n  现象：${oneLine(input.quote ?? input.content)}\n  触发：用户在主对话明确要求记忆或纠正。\n  期待：${entry.content}\n  出处：${source} · 记录于 ${date}`);
            }
            // An entry too large to fit alone is refused; anything else over the limit is evicted.
            assertEntriesFit(parseMemory(files['MEMORY.md']), entries);
            files['MEMORY.md'] = serializeMemory(entries);
            await this.publish(files, digest);
            return { entry: entry };
        });
    }
    /** Workspace's existing revision check remains inside this mutation barrier. */
    async editFile(absolutePath, content, save) {
        // Symlinks are resolved on both sides: a save arrives with its real path.
        const disk = await memoryRelativePath(this.root, absolutePath);
        const name = disk === undefined ? undefined : memoryLogicalName(disk);
        if (!name)
            return save();
        return this.withLock(async () => {
            validateFiles({ [name]: content });
            await this.repairDamagedState({ name, content });
            // An invalid file must stay repairable here: only the new content is validated then,
            // and reconciliation against the last valid baseline runs once every file parses.
            // Direct writes made before this save are absorbed first, without user authority.
            const files = await this.reconcileIfValid('direct');
            validateFiles(files ? { ...files, [name]: content } : { [name]: content });
            assertSavedEntriesFit(name, content, files);
            if (!files)
                await this.keepInvalidFile(name);
            const result = await save();
            const reconciled = await this.reconcileIfValid('settings');
            if (!reconciled)
                return result;
            // Workspace saves use a SHA-256 revision for these bounded text files.
            // Reconciliation can rewrite metadata, so return the revision of the final bytes.
            if (typeof result === 'object' &&
                result !== null &&
                'ok' in result &&
                result.ok === true &&
                'revision' in result)
                return {
                    ...result,
                    revision: `sha256:${createHash('sha256').update(reconciled[name]).digest('hex')}`,
                };
            return result;
        });
    }
    /** Entries of the main memory, for Bunny's daily stock. */
    async entryCount() {
        return parseMemory((await this.read())['MEMORY.md'] ?? '').length;
    }
    async lintState() {
        return this.state();
    }
    async nextEntryNumber() {
        return (await this.state()).highWater + 1;
    }
    async idleJobId() {
        return (await this.state()).idleJobId;
    }
    async setIdleJobId(idleJobId) {
        await this.saveState({ ...(await this.state()), idleJobId });
    }
    async markLint() {
        const state = await this.state();
        await this.saveState({ ...state, lastLintMs: this.nowMs(), manualEdits: '' });
    }
    async createWorkDir(files) {
        const work = join(dirname(this.root), `.memory-work-${randomUUID()}`);
        await mkdir(join(work, 'daily'), { recursive: true });
        for (const [name, text] of Object.entries(files))
            await writeFile(join(work, name), text);
        return work;
    }
}
/** A settings save of the main memory with one entry alone over the limit is refused. */
function assertSavedEntriesFit(name, content, files) {
    if (name !== 'MEMORY.md')
        return;
    assertEntriesFit(files ? parseMemory(files['MEMORY.md']) : [], parseMemory(content));
}
/** The main memory within the limit: unchanged when it fits, else without its oldest entries. */
function fitWritten(text, written) {
    if (!overMemoryLimit(text))
        return { text, evicted: [] };
    const { kept, evicted } = fitMemory(written);
    return { text: serializeMemory(kept), evicted };
}
/**
 * Where a path sits under the memory root (`/`-separated), or undefined outside
 * it. Both sides are compared with their symlinks resolved as far as they
 * exist: a save arrives with its real path, while the root may be configured
 * through a link (macOS `$TMPDIR` under `/var`, which is `/private/var`).
 */
export async function memoryRelativePath(root, target) {
    const [realRoot, realTarget] = await Promise.all([
        existingRealPath(root),
        existingRealPath(target),
    ]);
    const name = relative(realRoot, realTarget);
    if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name))
        return undefined;
    return name.split(sep).join('/');
}
/** The real path of the deepest existing ancestor, with the rest appended. */
async function existingRealPath(target) {
    const absolute = resolve(target);
    try {
        return await realpath(absolute);
    }
    catch {
        const parent = dirname(absolute);
        return parent === absolute
            ? absolute
            : join(await existingRealPath(parent), basename(absolute));
    }
}
//# sourceMappingURL=file-store.js.map