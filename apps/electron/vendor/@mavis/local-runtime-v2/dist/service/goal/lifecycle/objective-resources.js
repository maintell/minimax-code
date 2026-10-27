/** Persist source bytes first; only the caller's atomic Goal write admits the references. */
export async function withPreparedGoalResources(assets, sessionId, resources, commit) {
    if (resources === undefined)
        return commit(undefined);
    // An existing asset must belong to this Session. Never trust a renderer path
    // just because it looks like an asset path.
    const sources = await Promise.all(resources.map(async (resource) => {
        if (resource.assetId) {
            const asset = await assets.resolve({ sessionId, assetId: resource.assetId });
            if (!asset)
                throw new Error('Local attachment source is unreadable or invalid');
            return { ...resource, filePath: asset.absolutePath, dataUrl: undefined };
        }
        return resource;
    }));
    const registered = await assets.register({
        sessionId,
        attachments: sources.map((resource) => ({ ...resource })),
    });
    const created = registered.flatMap((resource, index) => resource.assetId && resource.assetId !== sources[index]?.assetId
        ? [{ assetId: resource.assetId, filePath: resource.filePath }]
        : []);
    try {
        const durable = registered.map(({ type, filePath, fileName, mimeType, assetId }) => {
            if (!assetId || !filePath)
                throw new Error('asset_source_required');
            return { type, filePath, fileName, mimeType, assetId };
        });
        return await commit(durable);
    }
    catch (error) {
        await assets.discard({ sessionId, receipts: created });
        throw error;
    }
}
//# sourceMappingURL=objective-resources.js.map