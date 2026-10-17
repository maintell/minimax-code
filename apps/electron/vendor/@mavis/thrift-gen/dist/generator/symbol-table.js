export function buildSymbolTable(ir) {
    const files = new Map();
    for (const file of ir.files) {
        if (files.has(file.path)) {
            throw new Error(`Duplicate thrift file in IR: ${file.path}`);
        }
        files.set(file.path, file);
    }
    const table = {
        ir,
        files,
        scopes: new Map(),
        byFileAndName: new Map(),
    };
    for (const file of ir.files) {
        table.scopes.set(file.path, buildFileScope(table, file));
        for (const declaration of file.typedefs) {
            addSymbol(table, file.path, 'typedef', declaration.name, declaration);
        }
        for (const declaration of file.enums) {
            addSymbol(table, file.path, 'enum', declaration.name, declaration);
        }
        for (const declaration of file.structs) {
            addSymbol(table, file.path, 'struct', declaration.name, declaration);
        }
        for (const declaration of file.services) {
            addSymbol(table, file.path, 'service', declaration.name, declaration);
        }
    }
    return table;
}
export function getFileScope(table, filePath) {
    const scope = table.scopes.get(filePath);
    if (!scope)
        throw new Error(`Unknown thrift file scope: ${filePath}`);
    return scope;
}
export function lookupLocalSymbol(table, filePath, name) {
    return table.byFileAndName.get(symbolKey(filePath, name));
}
export function lookupIncludedSymbol(table, filePath, qualifiedName) {
    const splitAt = qualifiedName.indexOf('.');
    if (splitAt <= 0 || splitAt === qualifiedName.length - 1)
        return undefined;
    const alias = qualifiedName.slice(0, splitAt);
    const name = qualifiedName.slice(splitAt + 1);
    const include = getFileScope(table, filePath).includeByAlias.get(alias);
    if (!include)
        return undefined;
    return lookupLocalSymbol(table, include.resolvedPath, name);
}
export function symbolKey(filePath, name) {
    return `${filePath}#${name}`;
}
function buildFileScope(table, file) {
    const includeByAlias = new Map();
    for (const include of file.includes) {
        if (includeByAlias.has(include.alias)) {
            throw new Error(`${file.path}: duplicate include alias ${include.alias}`);
        }
        if (!table.files.has(include.resolvedPath)) {
            throw new Error(`${file.path}: include ${include.path} resolved to missing file ${include.resolvedPath}`);
        }
        includeByAlias.set(include.alias, include);
    }
    return { file, includeByAlias };
}
function addSymbol(table, filePath, kind, name, declaration) {
    const key = symbolKey(filePath, name);
    const existing = table.byFileAndName.get(key);
    if (existing) {
        throw new Error(`${filePath}: duplicate symbol ${name} (${existing.kind} and ${kind}) in the same file`);
    }
    table.byFileAndName.set(key, { kind, name, filePath, declaration });
}
//# sourceMappingURL=symbol-table.js.map