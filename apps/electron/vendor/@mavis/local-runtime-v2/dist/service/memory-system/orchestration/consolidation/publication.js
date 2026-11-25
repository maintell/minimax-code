export async function readPublishedArtifacts(fileStore, scopeKey) {
    return {
        index: await fileStore.readMemoryIndex(scopeKey),
        summary: await fileStore.readMemorySummary(scopeKey),
    };
}
export async function restoreArtifacts(fileStore, scopeKey, prior) {
    if (prior.index !== undefined)
        await fileStore.writeMemoryIndex(scopeKey, prior.index);
    if (prior.summary !== undefined) {
        await fileStore.writeMemorySummary(scopeKey, prior.summary);
    }
}
//# sourceMappingURL=publication.js.map