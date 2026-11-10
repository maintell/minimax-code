import { pptAssetJournalPath, beginPptAssetCommit } from "./pptx-edit/asset-commit-recovery";
import { randomBytes, createHash } from "node:crypto";
import { open, lstat, realpath, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
/** All paths come from a main-owned source lease, never from the IPC payload. */
export async function commitPptxNotes(input) {
    const dir = path.dirname(input.file);
    const suffix = randomBytes(16).toString('hex');
    const temp = path.join(dir, `.pptx-notes-${suffix}.tmp`);
    const backup = path.join(dir, `.pptx-notes-${suffix}.backup`);
    const metadataTemp = path.join(dir, `.pptx-notes-${suffix}.json.tmp`);
    const metadataBackup = path.join(dir, `.pptx-notes-${suffix}.json.backup`);
    const journal = input.assetSidecar ? pptAssetJournalPath(input.file) : null;
    const endCommit = input.assetSidecar ? beginPptAssetCommit(input.file) : () => undefined;
    let journalCreated = false;
    let updatedMetadata;
    let committed = false;
    let keepBackup = false;
    let sidecarBefore;
    const writeSynced = async (target, bytes, mode) => {
        const handle = await open(target, 'wx', mode);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    };
    try {
        const info = await lstat(input.file);
        if (!info.isFile() || (await realpath(input.file)) !== input.file || !(await input.validate()))
            throw new Error('source_mutated');
        if (input.assetSidecar) {
            const sidecarInfo = await lstat(input.assetSidecar);
            if (!sidecarInfo.isFile() ||
                (await realpath(input.assetSidecar)) !== input.assetSidecar ||
                sidecarInfo.size > 1024 * 1024)
                throw new Error('source_mutated');
            sidecarBefore = await readFile(input.assetSidecar);
            const metadata = JSON.parse(sidecarBefore.toString('utf8'));
            const sha = createHash('sha256').update(input.original).digest('hex');
            if (metadata.sha256 !== sha || metadata.bytes !== input.original.length)
                throw new Error('source_mutated');
            updatedMetadata = Buffer.from(JSON.stringify({
                ...metadata,
                bytes: input.updated.length,
                sha256: createHash('sha256').update(input.updated).digest('hex'),
            }));
            await writeSynced(metadataTemp, updatedMetadata, sidecarInfo.mode & 0o777);
            await writeSynced(metadataBackup, sidecarBefore, sidecarInfo.mode & 0o777);
        }
        await writeSynced(temp, input.updated, info.mode & 0o777);
        // Retained until BOTH file and asset metadata commit. Recovery never needs a partial ZIP.
        await writeSynced(backup, input.original, info.mode & 0o777);
        const updatedInfo = await lstat(temp);
        if (!(await input.validate()) ||
            (await realpath(input.file)) !== input.file ||
            (input.assetSidecar && !(await readFile(input.assetSidecar)).equals(sidecarBefore)))
            throw new Error('source_mutated');
        if (journal) {
            const sha = (value) => createHash('sha256').update(value).digest('hex');
            await writeSynced(journal, Buffer.from(JSON.stringify({
                schema: 'mavis.pptx_asset_commit.v1',
                backup: path.basename(backup),
                metadataTemp: path.basename(metadataTemp),
                metadataBackup: path.basename(metadataBackup),
                originalSha: sha(input.original),
                updatedSha: sha(input.updated),
                metadataBeforeSha: sha(sidecarBefore),
                metadataAfterSha: sha(updatedMetadata),
            })), 0o600);
            journalCreated = true;
        }
        await rename(temp, input.file);
        committed = true;
        if (input.assetSidecar)
            await rename(metadataTemp, input.assetSidecar);
        return updatedInfo;
    }
    catch (error) {
        if (committed) {
            keepBackup = true;
            // Do not overwrite a newer external edit while recovering a metadata failure.
            if ((await readFile(input.file)).equals(input.updated)) {
                try {
                    await rename(backup, input.file);
                    keepBackup = false;
                    if (input.assetSidecar && updatedMetadata && sidecarBefore) {
                        const current = await readFile(input.assetSidecar);
                        if (current.equals(updatedMetadata))
                            await rename(metadataBackup, input.assetSidecar);
                        else if (!current.equals(sidecarBefore))
                            keepBackup = true;
                    }
                }
                catch {
                    keepBackup = true;
                }
            }
            else
                keepBackup = true;
        }
        throw error;
    }
    finally {
        await rm(temp, { force: true }).catch(() => undefined);
        if (!keepBackup) {
            if (journal && journalCreated)
                await rm(journal, { force: true }).catch(() => undefined);
            await rm(metadataTemp, { force: true }).catch(() => undefined);
            await rm(metadataBackup, { force: true }).catch(() => undefined);
        }
        if (!keepBackup)
            await rm(backup, { force: true }).catch(() => undefined);
        endCommit();
    }
}
