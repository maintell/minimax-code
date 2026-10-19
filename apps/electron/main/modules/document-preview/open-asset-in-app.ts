import path from "node:path";
/** Launch through the current local runtime's installed-application catalog. */
export async function openAssetPathInApp(target, appId) {
    const { handleLocalRuntimeRequest } = await import('../local-runtime');
    const response = await handleLocalRuntimeRequest(new Request(`http://127.0.0.1/mavis/api/file/${appId ? 'open-in-ide' : 'open'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appId
            ? { path: target, ideId: appId }
            : { workspace: path.dirname(target), path: path.basename(target) }),
    }));
    if (!response.ok)
        throw new Error('The application could not open the attachment');
}
