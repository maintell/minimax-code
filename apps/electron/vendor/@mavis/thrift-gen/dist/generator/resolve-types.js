import { lookupIncludedSymbol, lookupLocalSymbol, symbolKey, } from './symbol-table.js';
export function resolveType(table, currentFilePath, type) {
    return resolveTypeInternal(table, currentFilePath, type, new Set());
}
export function resolveUnderlyingType(type) {
    if (type.kind === 'typedef')
        return resolveUnderlyingType(type.targetType);
    return type;
}
export function categoryByName(table, currentFilePath, type) {
    const resolved = resolveType(table, currentFilePath, type);
    if (resolved.kind === 'builtin')
        return resolved.category;
    return resolved.kind;
}
function resolveTypeInternal(table, currentFilePath, type, visitedTypedefs) {
    switch (type.kind) {
        case 'builtin':
            return { kind: 'builtin', name: type.name, category: normalizeBuiltinCategory(type.name) };
        case 'list':
            return {
                kind: 'list',
                valueType: resolveTypeInternal(table, currentFilePath, type.valueType, visitedTypedefs),
            };
        case 'set':
            return {
                kind: 'set',
                valueType: resolveTypeInternal(table, currentFilePath, type.valueType, visitedTypedefs),
            };
        case 'map':
            return {
                kind: 'map',
                keyType: resolveTypeInternal(table, currentFilePath, type.keyType, visitedTypedefs),
                valueType: resolveTypeInternal(table, currentFilePath, type.valueType, visitedTypedefs),
            };
        case 'identifier':
            return resolveIdentifier(table, currentFilePath, type.name, visitedTypedefs);
        default: {
            const exhaustiveCheck = type;
            return exhaustiveCheck;
        }
    }
}
function resolveIdentifier(table, currentFilePath, name, visitedTypedefs) {
    const symbol = name.includes('.')
        ? lookupIncludedSymbol(table, currentFilePath, name)
        : lookupLocalSymbol(table, currentFilePath, name);
    if (!symbol) {
        throw new Error(`${currentFilePath}: unknown thrift type ${name}`);
    }
    if (symbol.kind === 'service') {
        throw new Error(`${currentFilePath}: service ${name} cannot be used as a field or return type`);
    }
    if (symbol.kind === 'enum')
        return { kind: 'enum', symbol };
    if (symbol.kind === 'struct')
        return { kind: 'struct', symbol };
    const key = symbolKey(symbol.filePath, symbol.name);
    if (visitedTypedefs.has(key)) {
        throw new Error(`${currentFilePath}: typedef cycle detected at ${symbol.name}`);
    }
    const nextVisited = new Set(visitedTypedefs);
    nextVisited.add(key);
    const declaration = symbol.declaration;
    if (!('targetType' in declaration)) {
        throw new Error(`${currentFilePath}: symbol ${symbol.name} is not a typedef`);
    }
    return {
        kind: 'typedef',
        symbol,
        targetType: resolveTypeInternal(table, symbol.filePath, declaration.targetType, nextVisited),
    };
}
function normalizeBuiltinCategory(name) {
    if (name === 'byte' || name === 'i8')
        return 'byte';
    return name;
}
//# sourceMappingURL=resolve-types.js.map