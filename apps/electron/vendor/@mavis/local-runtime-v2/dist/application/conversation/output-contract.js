import { ApplicationError } from './errors.js';
/**
 * The per-Turn JSON output contract of a send request, snapshotted so later
 * mutation of the caller's objects cannot change what the Turn enforces.
 */
export function outputContractField(req) {
    if (req.outputFormat !== undefined && req.outputSchema !== undefined) {
        throw new ApplicationError(400, 'local_output_format_conflict', 'outputFormat and outputSchema cannot be used together.');
    }
    if (req.outputSchema !== undefined) {
        return {
            outputContract: {
                type: 'json_schema',
                schema: snapshotLegacyOutputSchema(req.outputSchema),
            },
        };
    }
    if (req.outputFormat === undefined)
        return {};
    if (!isPlainRecord(req.outputFormat)) {
        throw invalidOutputFormat('outputFormat must be an object with a supported type.');
    }
    if (req.outputFormat.type === 'json_object') {
        assertExactKeys(req.outputFormat, ['type'], 'json_object outputFormat');
        return { outputContract: { type: 'json_object' } };
    }
    if (req.outputFormat.type === 'json_schema') {
        assertExactKeys(req.outputFormat, ['type', 'schema'], 'json_schema outputFormat');
        return {
            outputContract: {
                type: 'json_schema',
                schema: snapshotJsonSchemaObject(req.outputFormat.schema, 'outputFormat.schema'),
            },
        };
    }
    throw invalidOutputFormat('outputFormat.type must be json_object or json_schema.');
}
function snapshotLegacyOutputSchema(value) {
    if (!isPlainRecord(value)) {
        throw invalidOutputFormat('outputSchema must be a JSON Schema object.');
    }
    // Keep the legacy Host snapshot semantics, including optional undefined values.
    // Detach before attachment registration; Host validation still runs downstream.
    try {
        return structuredClone(value);
    }
    catch {
        throw invalidOutputFormat('outputSchema must support structured cloning.');
    }
}
function snapshotJsonSchemaObject(value, field) {
    if (!isPlainRecord(value)) {
        throw invalidOutputFormat(`${field} must be a JSON Schema object.`);
    }
    return snapshotJsonValue(value, field, new Set());
}
function snapshotJsonValue(value, path, ancestors) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (Number.isFinite(value))
            return value;
        throw invalidOutputFormat(`${path} must contain only finite JSON numbers.`);
    }
    if (typeof value !== 'object') {
        throw invalidOutputFormat(`${path} must contain only JSON-compatible values.`);
    }
    return snapshotJsonComposite(value, path, ancestors);
}
function snapshotJsonComposite(value, path, ancestors) {
    if (ancestors.has(value)) {
        throw invalidOutputFormat(`${path} must not contain circular references.`);
    }
    ancestors.add(value);
    try {
        return Array.isArray(value)
            ? snapshotJsonArray(value, path, ancestors)
            : snapshotJsonRecord(value, path, ancestors);
    }
    finally {
        ancestors.delete(value);
    }
}
function snapshotJsonArray(value, path, ancestors) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw invalidOutputFormat(`${path} must not contain symbol properties.`);
    }
    const snapshot = Array.from({ length: value.length }, (_, index) => {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw invalidOutputFormat(`${path}[${String(index)}] must not be an array hole.`);
        }
        return snapshotJsonValue(value[index], `${path}[${String(index)}]`, ancestors);
    });
    return Object.freeze(snapshot);
}
function snapshotJsonRecord(value, path, ancestors) {
    if (!isPlainRecord(value)) {
        throw invalidOutputFormat(`${path} must contain only plain JSON objects.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw invalidOutputFormat(`${path} must not contain symbol properties.`);
    }
    const snapshot = {};
    for (const [key, child] of Object.entries(value)) {
        Object.defineProperty(snapshot, key, {
            value: snapshotJsonValue(child, `${path}.${key}`, ancestors),
            enumerable: true,
            configurable: false,
            writable: false,
        });
    }
    return Object.freeze(snapshot);
}
function assertExactKeys(value, allowedKeys, field) {
    if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
        throw invalidOutputFormat(`${field} contains unsupported fields.`);
    }
}
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function invalidOutputFormat(message) {
    return new ApplicationError(400, 'local_output_format_invalid', message);
}
//# sourceMappingURL=output-contract.js.map