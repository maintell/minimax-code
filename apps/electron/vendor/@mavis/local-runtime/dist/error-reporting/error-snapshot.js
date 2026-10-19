/** 原始异常快照的 JSON 安全表示。快照不脱敏，由上报器在出进程前统一加密。 */
export function snapshotErrorValue(value, rootPath) {
    try {
        return snapshotValue(value, rootPath, { seen: new WeakMap() });
    }
    catch (error) {
        return {
            type: 'SnapshotFailure',
            message: error instanceof Error ? `${error.name}: ${error.message}` : safeText(error),
        };
    }
}
function snapshotValue(value, path, state) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : { number: String(value) };
    }
    if (typeof value === 'undefined')
        return { type: 'undefined' };
    if (typeof value === 'bigint')
        return { bigint: value.toString() };
    if (typeof value === 'symbol')
        return { symbol: String(value) };
    if (typeof value === 'function')
        return { function: value.name || 'anonymous' };
    const existingPath = state.seen.get(value);
    if (existingPath)
        return { $ref: existingPath };
    state.seen.set(value, path);
    if (value instanceof Error)
        return snapshotError(value, path, state);
    if (Array.isArray(value)) {
        return value.map((item, index) => snapshotValue(item, `${path}[${index}]`, state));
    }
    if (value instanceof Date)
        return { type: 'Date', value: value.toISOString() };
    if (value instanceof RegExp)
        return { type: 'RegExp', value: String(value) };
    if (value instanceof URL)
        return { type: 'URL', value: value.href };
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
        const entries = [];
        value.forEach((entryValue, entryKey) => entries.push([entryKey, entryValue]));
        return { type: 'Headers', entries };
    }
    if (value instanceof Map) {
        return {
            type: 'Map',
            entries: [...value.entries()].map(([key, item], index) => [
                snapshotValue(key, `${path}.entries[${index}].key`, state),
                snapshotValue(item, `${path}.entries[${index}].value`, state),
            ]),
        };
    }
    if (value instanceof Set) {
        return {
            type: 'Set',
            values: [...value.values()].map((item, index) => snapshotValue(item, `${path}.values[${index}]`, state)),
        };
    }
    if (ArrayBuffer.isView(value)) {
        const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        return {
            type: constructorName(value),
            byteLength: bytes.byteLength,
            base64: bytes.toString('base64'),
        };
    }
    if (value instanceof ArrayBuffer) {
        const bytes = Buffer.from(value);
        return { type: 'ArrayBuffer', byteLength: bytes.byteLength, base64: bytes.toString('base64') };
    }
    return snapshotObject(value, path, state);
}
function snapshotError(error, path, state) {
    const descriptors = ownDescriptors(error);
    const result = {
        type: 'Error',
        constructor: constructorName(error),
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
    };
    const causeDescriptor = descriptors.cause;
    if (causeDescriptor && 'value' in causeDescriptor) {
        result.cause = snapshotValue(causeDescriptor.value, `${path}.cause`, state);
    }
    if (error instanceof AggregateError) {
        result.errors = snapshotValue(error.errors, `${path}.errors`, state);
    }
    const properties = snapshotDescriptors(descriptors, path, state, [
        'name',
        'message',
        'stack',
        'cause',
        ...(error instanceof AggregateError ? ['errors'] : []),
    ]);
    if (Object.keys(properties).length > 0)
        result.properties = properties;
    return result;
}
function snapshotObject(value, path, state) {
    const properties = snapshotDescriptors(ownDescriptors(value), path, state);
    return {
        type: 'Object',
        constructor: constructorName(value),
        properties,
    };
}
function snapshotDescriptors(descriptors, path, state, excluded = []) {
    const properties = {};
    const excludedNames = new Set(excluded);
    for (const key of Reflect.ownKeys(descriptors)) {
        const propertyName = typeof key === 'symbol' ? `[${String(key)}]` : key;
        if (excludedNames.has(propertyName))
            continue;
        const descriptor = descriptors[key];
        if (!descriptor)
            continue;
        if ('value' in descriptor) {
            properties[propertyName] = snapshotValue(descriptor.value, `${path}.properties.${propertyName}`, state);
            continue;
        }
        properties[propertyName] = {
            accessor: true,
            hasGetter: typeof descriptor.get === 'function',
            hasSetter: typeof descriptor.set === 'function',
        };
    }
    return properties;
}
function ownDescriptors(value) {
    try {
        return Object.getOwnPropertyDescriptors(value);
    }
    catch (error) {
        return {
            snapshotFailure: {
                configurable: true,
                enumerable: true,
                writable: true,
                value: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            },
        };
    }
}
function constructorName(value) {
    try {
        const prototype = Object.getPrototypeOf(value);
        const constructor = prototype
            ? Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
            : undefined;
        return typeof constructor === 'function' && constructor.name ? constructor.name : 'Object';
    }
    catch {
        return 'Object';
    }
}
function safeText(value) {
    try {
        return String(value);
    }
    catch {
        return 'unknown thrown value';
    }
}
//# sourceMappingURL=error-snapshot.js.map