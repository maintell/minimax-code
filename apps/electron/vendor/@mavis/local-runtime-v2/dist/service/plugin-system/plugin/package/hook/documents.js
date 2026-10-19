import { isRecord, pluginPathExists, readPluginJsonObject, resolvePluginFile, } from '../filesystem.js';
export async function loadPluginHookDocuments(root, declared, options) {
    if (isRecord(declared) && !isPathDeclaration(declared)) {
        return [{ sourcePath: options.manifestPath ?? '<manifest>', value: declared }];
    }
    const { paths, invalid } = readPathDeclaration(declared);
    await addDefaultPath(root, declared, options.defaultPath, paths);
    const documents = [];
    if (invalid) {
        documents.push({ sourcePath: options.manifestPath ?? '<manifest>', value: undefined });
    }
    const seenFiles = new Set();
    for (const relativePath of paths) {
        try {
            const file = await resolvePluginFile(root, relativePath);
            if (seenFiles.has(file))
                continue;
            seenFiles.add(file);
        }
        catch {
            // Preserve the bounded invalid-document diagnostic from readHookDocument.
        }
        documents.push(await readHookDocument(root, relativePath));
    }
    return documents;
}
async function addDefaultPath(root, declared, defaultPath, paths) {
    if (paths.length > 0 || declared !== undefined || !defaultPath)
        return;
    if (await pluginPathExists(root, defaultPath, 'file'))
        paths.push(defaultPath);
}
async function readHookDocument(root, relativePath) {
    try {
        const { value } = await readPluginJsonObject(root, relativePath);
        return { sourcePath: relativePath, value };
    }
    catch {
        return { sourcePath: relativePath, value: undefined };
    }
}
function isPathDeclaration(value) {
    return typeof value.path === 'string';
}
function readPathDeclaration(value) {
    if (value === undefined)
        return { paths: [], invalid: false };
    const direct = declaredPath(value);
    if (direct)
        return { paths: [direct], invalid: false };
    if (!Array.isArray(value))
        return { paths: [], invalid: true };
    const paths = [];
    let invalid = false;
    for (const item of value) {
        const path = declaredPath(item);
        if (path)
            paths.push(path);
        else
            invalid = true;
    }
    return { paths, invalid };
}
function declaredPath(value) {
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (!isRecord(value) || typeof value.path !== 'string' || !value.path.trim())
        return undefined;
    return value.path.trim();
}
//# sourceMappingURL=documents.js.map