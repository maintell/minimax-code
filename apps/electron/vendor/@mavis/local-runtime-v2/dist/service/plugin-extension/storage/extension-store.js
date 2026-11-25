import { rm } from 'node:fs/promises';
import path from 'node:path';
import { jsonEqual } from '@mavis/shared/plugin-extension';
import { KeyedOperationQueue } from '../../../infra/util/keyed-operation-queue.js';
import { ExtensionServiceError } from '../errors.js';
import { toJsonText } from '../json-value.js';
import { jsonBytesUnder, listDirNames, listFileNames, readTextIfExists, resolveContainedDir, sizeIfExists, writeFileAtomic, } from './store-files.js';
import { assertPathSegments, assertStoreKey, fileStemToKey, keyToFileStem } from './store-keys.js';
const DEFAULT_STORE_LIMITS = {
    maxValueBytes: 256 * 1024,
    maxPluginBytes: 8 * 1024 * 1024,
};
const VALUE = '.json';
const TOMBSTONE = '.del';
/**
 * File-backed KV under `<root>/<pluginId>/`: `data/` holds installed values, `preview/<sessionId>/`
 * the copy-on-write overlay (`.json` values, `.del` tombstones). Writes of one plugin are
 * serialized so the byte quota stays exact.
 */
export class ExtensionKvStore {
    root;
    options;
    locks = new KeyedOperationQueue();
    usage = new Map();
    constructor(root, options = {}) {
        this.root = root;
        this.options = options;
    }
    get limits() {
        return this.options.limits ?? DEFAULT_STORE_LIMITS;
    }
    async get(view, key) {
        assertStoreKey(key);
        return this.read(view, keyToFileStem(key));
    }
    async keys(view) {
        const base = await this.dir(view.pluginId, undefined, false);
        const stems = new Set(stemsOf(await listFileNames(base), VALUE));
        if (view.overlaySessionId !== undefined) {
            const names = await listFileNames(await this.dir(view.pluginId, view.overlaySessionId, false));
            for (const stem of stemsOf(names, VALUE))
                stems.add(stem);
            for (const stem of stemsOf(names, TOMBSTONE))
                stems.delete(stem);
        }
        return [...stems]
            .map(fileStemToKey)
            .filter((key) => key !== undefined)
            .sort();
    }
    async set(view, key, value) {
        assertStoreKey(key);
        const text = toJsonText(value, 'store value');
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > this.limits.maxValueBytes) {
            throw new ExtensionServiceError('STORE_QUOTA_EXCEEDED', `store value exceeds ${this.limits.maxValueBytes} bytes`);
        }
        const stem = keyToFileStem(key);
        await this.withLock(view.pluginId, async () => {
            const { before, dir, file, size } = await this.locate(view, stem);
            const delta = bytes - size;
            const used = await this.pluginUsage(view.pluginId);
            if (used + delta > this.limits.maxPluginBytes) {
                throw new ExtensionServiceError('STORE_QUOTA_EXCEEDED', `plugin store exceeds ${this.limits.maxPluginBytes} bytes`);
            }
            await writeFileAtomic(file, text);
            this.usage.set(view.pluginId, used + delta);
            if (view.overlaySessionId !== undefined)
                await rm(path.join(dir, stem + TOMBSTONE), { force: true });
            if (!jsonEqual(before, value))
                this.notify(view, key);
        });
    }
    async delete(view, key) {
        assertStoreKey(key);
        const stem = keyToFileStem(key);
        await this.withLock(view.pluginId, async () => {
            const { before, dir, file, size } = await this.locate(view, stem);
            // Usage is read before the file goes: a cold scan afterwards would not count it twice.
            const used = await this.pluginUsage(view.pluginId);
            await rm(file, { force: true });
            this.usage.set(view.pluginId, used - size);
            if (view.overlaySessionId !== undefined) {
                await writeFileAtomic(path.join(dir, stem + TOMBSTONE), '');
            }
            if (before !== undefined)
                this.notify(view, key);
        });
    }
    /** Whether the overlay of `sessionId` hides the installed value of `key`. */
    async shadows(pluginId, sessionId, key) {
        const dir = await this.dir(pluginId, sessionId, false);
        if (!dir)
            return false;
        const stem = keyToFileStem(key);
        for (const suffix of [VALUE, TOMBSTONE]) {
            if ((await sizeIfExists(path.join(dir, stem + suffix))) !== undefined)
                return true;
        }
        return false;
    }
    /**
     * Folds a session's overlay into the installed data (overlay values win, tombstones delete),
     * then drops the overlay. Every step is idempotent and the overlay goes last, so a merge a
     * crash interrupted completes when it runs again.
     */
    async mergeOverlay(pluginId, sessionId) {
        await this.withLock(pluginId, async () => {
            const overlay = await this.dir(pluginId, sessionId, false);
            if (!overlay)
                return;
            const names = await listFileNames(overlay);
            const data = await this.requireDir(pluginId, undefined);
            const changed = [];
            for (const stem of stemsOf(names, VALUE)) {
                const text = await readTextIfExists(path.join(overlay, stem + VALUE));
                if (text === undefined)
                    continue;
                await writeFileAtomic(path.join(data, stem + VALUE), text);
                changed.push(stem);
            }
            for (const stem of stemsOf(names, TOMBSTONE)) {
                await rm(path.join(data, stem + VALUE), { force: true });
                changed.push(stem);
            }
            await rm(overlay, { recursive: true, force: true });
            this.usage.delete(pluginId);
            for (const key of new Set(changed.map(fileStemToKey))) {
                if (key !== undefined)
                    this.notify({ pluginId }, key);
            }
        });
    }
    /** Every preview overlay on disk, for startup reconciliation. */
    async listOverlays() {
        const overlays = [];
        for (const pluginId of await listDirNames(this.root)) {
            for (const sessionId of await listDirNames(path.join(this.root, pluginId, 'preview'))) {
                overlays.push({ pluginId, sessionId });
            }
        }
        return overlays;
    }
    async discardOverlay(pluginId, sessionId) {
        await this.withLock(pluginId, async () => {
            const overlay = await this.dir(pluginId, sessionId, false);
            if (overlay)
                await rm(overlay, { recursive: true, force: true });
            this.usage.delete(pluginId);
        });
    }
    async discardSession(sessionId) {
        for (const pluginId of await listDirNames(this.root)) {
            if (await this.overlayExists(pluginId, sessionId))
                await this.discardOverlay(pluginId, sessionId);
        }
    }
    async overlayExists(pluginId, sessionId) {
        try {
            return (await this.dir(pluginId, sessionId, false)) !== undefined;
        }
        catch {
            return false;
        }
    }
    async read(view, stem) {
        if (view.overlaySessionId !== undefined) {
            const overlay = await this.dir(view.pluginId, view.overlaySessionId, false);
            if (overlay) {
                if ((await sizeIfExists(path.join(overlay, stem + TOMBSTONE))) !== undefined)
                    return undefined;
                const text = await readTextIfExists(path.join(overlay, stem + VALUE));
                if (text !== undefined)
                    return parse(text);
            }
        }
        const base = await this.dir(view.pluginId, undefined, false);
        const text = base ? await readTextIfExists(path.join(base, stem + VALUE)) : undefined;
        return text === undefined ? undefined : parse(text);
    }
    /** Visible value plus the writable file of `stem` in this view and its current size. */
    async locate(view, stem) {
        const before = await this.read(view, stem);
        const dir = await this.requireDir(view.pluginId, view.overlaySessionId);
        const file = path.join(dir, stem + VALUE);
        return { before, dir, file, size: (await sizeIfExists(file)) ?? 0 };
    }
    async requireDir(pluginId, sessionId) {
        const dir = await this.dir(pluginId, sessionId, true);
        if (!dir)
            throw new ExtensionServiceError('STORE_KEY_INVALID', 'store directory unavailable');
        return dir;
    }
    async dir(pluginId, sessionId, create) {
        assertPathSegments(pluginId, sessionId);
        const dir = sessionId === undefined
            ? path.join(this.root, pluginId, 'data')
            : path.join(this.root, pluginId, 'preview', sessionId);
        return resolveContainedDir({ root: this.root, namespace: pluginId, dir, create });
    }
    async pluginUsage(pluginId) {
        const cached = this.usage.get(pluginId);
        if (cached !== undefined)
            return cached;
        const pluginDir = await resolveContainedDir({
            root: this.root,
            namespace: pluginId,
            dir: path.join(this.root, pluginId),
            create: false,
        });
        const total = pluginDir ? await jsonBytesUnder(pluginDir) : 0;
        this.usage.set(pluginId, total);
        return total;
    }
    notify(view, key) {
        this.options.onChange?.({
            pluginId: view.pluginId,
            ...(view.overlaySessionId === undefined ? {} : { overlaySessionId: view.overlaySessionId }),
            key,
        });
    }
    async withLock(pluginId, task) {
        return this.locks.run(pluginId, task);
    }
}
function stemsOf(names, suffix) {
    return names.filter((name) => name.endsWith(suffix)).map((name) => name.slice(0, -suffix.length));
}
function parse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=extension-store.js.map