import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { issueSelectedFileCapability } from "./workspace-authority";
const MAX_FILES = 256;
/** Profile-owned exact-file grants minted only after an authorized native Save As. */
export class SavedPptFileAuthority {
    constructor(folder) {
        this.folder = folder;
        this.records = new Map();
        this.loaded = null;
        this.writes = Promise.resolve();
    }
    load() {
        return (this.loaded ?? (this.loaded = (async () => {
            try {
                const file = path.join(this.folder, 'files.json');
                const info = await lstat(file);
                if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024)
                    throw new Error('invalid_saved_file_grants');
                const data = JSON.parse(await readFile(file, 'utf8'));
                if (!Array.isArray(data) || data.length > MAX_FILES)
                    throw new Error('invalid_saved_file_grants');
                for (const entry of data) {
                    if (!Array.isArray(entry) ||
                        entry.length !== 2 ||
                        typeof entry[0] !== 'string' ||
                        !/^[A-Za-z0-9_-]{32}$/u.test(entry[0]) ||
                        typeof entry[1] !== 'string' ||
                        !path.isAbsolute(entry[1]) ||
                        !/\.pptx$/iu.test(entry[1]) ||
                        this.records.has(entry[0]))
                        throw new Error('invalid_saved_file_grants');
                    this.records.set(entry[0], entry[1]);
                }
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        })()));
    }
    async issue(filePath) {
        await this.load();
        const canonical = await realpath(filePath);
        const info = await lstat(filePath);
        if (info.isSymbolicLink() || !info.isFile() || !issueSelectedFileCapability(canonical))
            throw new Error('source_mutated');
        const token = randomBytes(24).toString('base64url');
        const task = this.writes
            .catch(() => undefined)
            .then(async () => {
            const next = new Map(this.records);
            next.set(token, canonical);
            while (next.size > MAX_FILES)
                next.delete(next.keys().next().value);
            await mkdir(this.folder, { recursive: true, mode: 0o700 });
            const temporary = path.join(this.folder, `files-${randomBytes(8).toString('hex')}.tmp`);
            await writeFile(temporary, JSON.stringify([...next]), { mode: 0o600, flag: 'wx' });
            await rename(temporary, path.join(this.folder, 'files.json'));
            this.records = next;
        });
        this.writes = task;
        await task;
        return token;
    }
    async resolve(token) {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(token))
            return null;
        await this.load();
        const filePath = this.records.get(token);
        if (!filePath)
            return null;
        try {
            if ((await realpath(filePath)) !== filePath || (await lstat(filePath)).isSymbolicLink())
                return null;
        }
        catch {
            return null;
        }
        return issueSelectedFileCapability(filePath);
    }
}

let authority;
export function savedPptFileAuthority() {
    return (authority ?? (authority = new SavedPptFileAuthority(path.join(app.getPath('userData'), 'pptx-edit', 'saved-files'))));
}
