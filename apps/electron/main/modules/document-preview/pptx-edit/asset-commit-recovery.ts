import { createHash } from "node:crypto";
import { lstat, realpath, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const pptAssetJournalPath = (file) => `${file}.mavis-pptx-edit.json`;

const activeCommits = new Set();
export function beginPptAssetCommit(file) {
    if (activeCommits.has(file))
        throw new Error('source_mutated');
    activeCommits.add(file);
    return () => activeCommits.delete(file);
}
async function regular(file, maxBytes) {
    const info = await lstat(file);
    if (!info.isFile() ||
        info.isSymbolicLink() ||
        info.size > maxBytes ||
        (await realpath(file)) !== file)
        throw new Error('source_mutated');
    return readFile(file);
}
/** Only the already scoped asset's canonical sibling can be repaired. */
export async function recoverPptAssetCommit(file, sidecar) {
    if (activeCommits.has(file))
        return;
    if (!/\.pptx$/iu.test(file) || sidecar !== `${file}.asset.json`)
        return;
    const journalFile = (0, pptAssetJournalPath)(file);
    let raw;
    try {
        raw = await regular(journalFile, 4096);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    const journal = JSON.parse(raw.toString('utf8'));
    if (journal.schema !== 'mavis.pptx_asset_commit.v1' ||
        ![
            journal.originalSha,
            journal.updatedSha,
            journal.metadataBeforeSha,
            journal.metadataAfterSha,
        ].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) ||
        !/^\.pptx-notes-[a-f0-9]{32}\.backup$/u.test(journal.backup) ||
        !/^\.pptx-notes-[a-f0-9]{32}\.json\.tmp$/u.test(journal.metadataTemp) ||
        !/^\.pptx-notes-[a-f0-9]{32}\.json\.backup$/u.test(journal.metadataBackup))
        throw new Error('source_mutated');
    const folder = path.dirname(file), backup = path.join(folder, journal.backup), metadataTemp = path.join(folder, journal.metadataTemp), metadataBackup = path.join(folder, journal.metadataBackup);
    const currentFileSha = hash(await regular(file, 100 * 1024 * 1024)), currentMeta = await regular(sidecar, 1024 * 1024), currentMetaSha = hash(currentMeta);
    const sameMetadata = (before, after) => {
        const previous = JSON.parse(before.toString('utf8')), next = JSON.parse(after.toString('utf8'));
        delete previous.sha256;
        delete previous.bytes;
        delete next.sha256;
        delete next.bytes;
        return JSON.stringify(previous) === JSON.stringify(next);
    };
    if (currentFileSha === journal.updatedSha && currentMetaSha === journal.metadataBeforeSha) {
        const next = await regular(metadataTemp, 1024 * 1024);
        const parsed = JSON.parse(next.toString('utf8'));
        if (hash(next) !== journal.metadataAfterSha ||
            !sameMetadata(currentMeta, next) ||
            parsed.sha256 !== journal.updatedSha ||
            parsed.bytes !== (await lstat(file)).size)
            throw new Error('source_mutated');
        await rename(metadataTemp, sidecar);
    }
    else if (currentFileSha === journal.originalSha &&
        currentMetaSha === journal.metadataAfterSha) {
        const before = await regular(metadataBackup, 1024 * 1024);
        if (hash(before) !== journal.metadataBeforeSha || !sameMetadata(before, currentMeta))
            throw new Error('source_mutated');
        await rename(metadataBackup, sidecar);
    }
    else if (!((currentFileSha === journal.updatedSha && currentMetaSha === journal.metadataAfterSha) ||
        (currentFileSha === journal.originalSha && currentMetaSha === journal.metadataBeforeSha)))
        throw new Error('source_mutated');
    await rm(journalFile);
    // Fixed reserved basenames only; no paths from mutable metadata are followed.
    await Promise.all([backup, metadataTemp, metadataBackup].map(async (candidate) => {
        try {
            await regular(candidate, 100 * 1024 * 1024);
            await rm(candidate);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }));
}
