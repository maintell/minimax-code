import { camelCase } from 'lodash-es';
import { resolveUnderlyingType } from './resolve-types.js';
export const THRIFT_I64_ALIAS = 'export type ThriftI64 = number;';
const RESERVED_WORDS = new Set([
    'abstract',
    'arguments',
    'await',
    'boolean',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'eval',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'var',
    'void',
    'while',
    'with',
    'yield',
]);
const PRETTIER_PRINT_WIDTH = 100;
export function emitTsType(type) {
    const resolved = resolveUnderlyingType(type);
    switch (resolved.kind) {
        case 'builtin':
            return emitBuiltinTsType(resolved.name);
        case 'enum':
        case 'struct':
            return assertTsIdentifier(resolved.symbol.name, `type ${resolved.symbol.name}`);
        case 'list':
        case 'set':
            return `${wrapArrayElementType(emitTsType(resolved.valueType))}[]`;
        case 'map': {
            const keyType = resolveUnderlyingType(resolved.keyType);
            if (keyType.kind !== 'builtin' || keyType.name !== 'string') {
                throw new Error('Only map<string, V> is supported for HTTP JSON generation');
            }
            return `Record<string, ${emitTsType(resolved.valueType)}>`;
        }
        default: {
            const exhaustiveCheck = resolved;
            return exhaustiveCheck;
        }
    }
}
export function isOptionalField(requiredness) {
    return requiredness !== 'required';
}
export function emitEnum(enumDeclaration) {
    const enumName = assertTsIdentifier(enumDeclaration.name, `enum ${enumDeclaration.name}`);
    const lines = [`export const ${enumName} = {`];
    for (const value of enumDeclaration.values) {
        lines.push(`  ${assertTsIdentifier(value.name, `enum value ${value.name}`)}: ${value.value},`);
    }
    lines.push('} as const;');
    lines.push(emitEnumTypeAlias(enumName));
    return lines.join('\n');
}
export function assertTsIdentifier(name, context) {
    if (!/^[$A-Z_a-z][$\w]*$/.test(name) || RESERVED_WORDS.has(name)) {
        throw new Error(`${context}: invalid TypeScript identifier ${name}`);
    }
    return name;
}
export function assertTsPropertyIdentifier(name, context) {
    if (!/^[$A-Z_a-z][$\w]*$/.test(name)) {
        throw new Error(`${context}: invalid TypeScript property identifier ${name}`);
    }
    return name;
}
export function thriftMethodToTsName(name) {
    const tsName = `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`;
    return assertTsIdentifier(tsName, `method ${name}`);
}
export function thriftFieldToTsPropertyName(name) {
    const tsName = camelCase(name);
    return assertTsPropertyIdentifier(tsName, `field ${name}`);
}
export function toScreamingSnake(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Z_a-z0-9]+/g, '_')
        .toUpperCase();
}
export function usesThriftI64(type) {
    const resolved = resolveUnderlyingType(type);
    switch (resolved.kind) {
        case 'builtin':
            return resolved.name === 'i64';
        case 'enum':
        case 'struct':
            return false;
        case 'list':
        case 'set':
            return usesThriftI64(resolved.valueType);
        case 'map':
            return usesThriftI64(resolved.keyType) || usesThriftI64(resolved.valueType);
        default: {
            const exhaustiveCheck = resolved;
            return exhaustiveCheck;
        }
    }
}
function emitBuiltinTsType(name) {
    switch (name) {
        case 'bool':
            return 'boolean';
        case 'byte':
        case 'i8':
        case 'i16':
        case 'i32':
        case 'double':
            return 'number';
        case 'i64':
            return 'ThriftI64';
        case 'string':
            return 'string';
        case 'binary':
            throw new Error('binary is not supported for HTTP JSON generation');
        default:
            throw new Error(`Unsupported thrift builtin ${name}`);
    }
}
function wrapArrayElementType(type) {
    return type.includes('|') || type.startsWith('Record<') ? `(${type})` : type;
}
function emitEnumTypeAlias(enumName) {
    const alias = `export type ${enumName} = (typeof ${enumName})[keyof typeof ${enumName}];`;
    if (alias.length <= PRETTIER_PRINT_WIDTH)
        return alias;
    return [`export type ${enumName} =`, `  (typeof ${enumName})[keyof typeof ${enumName}];`].join('\n');
}
//# sourceMappingURL=ts-type-mapper.js.map