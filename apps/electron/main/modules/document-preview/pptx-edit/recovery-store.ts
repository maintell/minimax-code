import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
/** Profile-private version snapshots; original files are never autosave destinations. */
export class PptEditRecoveryStore {
    constructor(root) {
        this.root = root;
    }
    key(scope) {
        return createHash('sha256').update(scope).digest('hex');
    }
    directory(scope) {
        return path.join(this.root, this.key(scope));
    }
    async load(scope, sourceSha256) {
        try {
            const folder = this.directory(scope);
            const metadata = await readFile(path.join(folder, 'record.json'));
            if (metadata.length > 4096)
                return null;
            const record = JSON.parse(metadata.toString('utf8'));
            if (record.schema !== 1 ||
                record.sourceSha256 !== sourceSha256 ||
                !/^snapshot-[a-f0-9-]+\.pptx$/u.test(record.file) ||
                !Number.isSafeInteger(record.revision) ||
                record.revision < 0)
                return null;
            const bytes = await readFile(path.join(folder, record.file));
            if (bytes.length > 134217728 || digest(bytes) !== record.snapshotSha256)
                return null;
            return { bytes, revision: record.revision };
        }
        catch {
            return null;
        }
    }
    async save(scope, sourceSha256, revision, bytes) {
        if (!/^sha256:[a-f0-9]{64}$/u.test(sourceSha256) ||
            !Number.isSafeInteger(revision) ||
            revision < 0 ||
            bytes.length > 134217728)
            throw new Error('invalid_request');
        const folder = this.directory(scope);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const file = `snapshot-${randomUUID()}.pptx`;
        const temp = path.join(folder, `record-${randomUUID()}.tmp`);
        let previous;
        try {
            const old = JSON.parse(await readFile(path.join(folder, 'record.json'), 'utf8'));
            if (/^snapshot-[a-f0-9-]+\.pptx$/u.test(old.file))
                previous = old.file;
        }
        catch {
            /* First snapshot. */
        }
        const synced = async (file, value) => {
            const handle = await open(file, 'wx', 0o600);
            try {
                await handle.writeFile(value);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        };
        try {
            await synced(path.join(folder, file), bytes);
            const record = {
                schema: 1,
                sourceSha256,
                snapshotSha256: digest(bytes),
                revision,
                file,
                updatedAtMs: Date.now(),
            };
            await synced(temp, Buffer.from(JSON.stringify(record)));
            await rename(temp, path.join(folder, 'record.json'));
            if (previous && previous !== file)
                await rm(path.join(folder, previous), { force: true }).catch(() => undefined);
        }
        catch (error) {
            await rm(path.join(folder, file), { force: true }).catch(() => undefined);
            throw error;
        }
        finally {
            await rm(temp, { force: true }).catch(() => undefined);
        }
    }
    async discard(scope) {
        await rm(this.directory(scope), { recursive: true, force: true });
    }
}

