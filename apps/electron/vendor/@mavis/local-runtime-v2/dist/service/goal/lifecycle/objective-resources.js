/** Persist source bytes first; only the caller's atomic Goal write admits the references. */
export async function withPreparedGoalResources(assets, sessionId, resources, commit) {
    if (resources === undefined)
        return commit(undefined);
    // An asset library item is a reference only: it has no bytes to persist.
    const files = resources.filter(isLocalResource);
    // An existing asset must belong to this Session. Never trust a renderer path
    // just because it looks like an asset path.
    const sources = await Promise.all(files.map(async (resource) => {
        if (resource.assetId) {
            const asset = await assets.resolve({ sessionId, assetId: resource.assetId });
            if (!asset)
                throw new Error('Local attachment source is unreadable or invalid');
            return { ...resource, filePath: asset.absolutePath, dataUrl: undefined };
        }
        return resource;
    }));
    const registered = sources.length > 0
        ? await assets.register({
            sessionId,
            attachments: sources.map((resource) => ({ ...resource })),
        })
        : [];
    const created = registered.flatMap((resource, index) => resource.assetId && resource.assetId !== sources[index]?.assetId
        ? [{ assetId: resource.assetId, filePath: resource.filePath }]
        : []);
    try {
        const durableFiles = registered.map(({ type, filePath, fileName, mimeType, assetId }) => {
            if (!assetId || !filePath)
                throw new Error('asset_source_required');
            return { type, filePath, fileName, mimeType, assetId };
        });
        if (durableFiles.length !== files.length)
            throw new Error('asset_source_required');
        let fileIndex = 0;
        const durable = resources.map((resource) => isLocalResource(resource) ? durableFiles[fileIndex++] : assetReference(resource));
        return await commit(durable);
    }
    catch (error) {
        await assets.discard({ sessionId, receipts: created });
        throw error;
    }
}
function isLocalResource(resource) {
    return !resource.driveNodeId && resource.type !== 'folder';
}
function assetReference(resource) {
    const { type, fileName, mimeType, driveNodeId, drivePath, sizeBytes } = resource;
    return {
        type,
        filePath: '',
        fileName,
        mimeType,
        ...(driveNodeId ? { driveNodeId } : {}),
        ...(drivePath ? { drivePath } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
}
//# sourceMappingURL=objective-resources.js.map