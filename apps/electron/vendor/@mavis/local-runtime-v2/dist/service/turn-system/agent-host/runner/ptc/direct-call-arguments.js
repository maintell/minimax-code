import { validateToolArguments } from '@earendil-works/pi-ai';
import { readPtcMavisChildTarget } from '@mavis/agent-tools';
const FIX_ORDER = [
    'item_wrapper',
    'number_string',
    'boolean_string',
];
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
/**
 * Repairs `value` against `schema`; returns the same object when nothing needed a repair.
 * @internal Exported for focused tests.
 */
export function normalizeDirectCallArguments(value, schema) {
    const fixes = new Set();
    const normalized = normalizeValue(value, schema, fixes);
    return { value: normalized, fixes: FIX_ORDER.filter((fix) => fixes.has(fix)) };
}
/**
 * The tool's own argument preparation, then the repair, then the schema
 * validation Pi runs next. Throws only what the tool's own preparation throws.
 *
 * A mavis_* tool is refused here even with valid arguments. It stands for a
 * mavis command, and only run_code runs it as that mavis call; run as itself,
 * the permission gate and Plugin hooks would see `mavis_<command>` instead of
 * `mavis`, and rules written for mavis would not apply. The model gets the
 * run_code line, as for any call whose arguments stay invalid, and the
 * command was refused at the top level before it had a tool of its own.
 */
export function prepareDirectCallArguments(tool, args) {
    const prepared = tool.def.prepareArguments ? tool.def.prepareArguments(args) : args;
    const normalized = normalizeDirectCallArguments(prepared, tool.def.schema);
    const runCodeOnly = readPtcMavisChildTarget(tool)
        ? `${tool.def.name} runs only inside run_code in this turn.`
        : undefined;
    try {
        validateToolArguments({
            name: tool.def.name,
            description: tool.def.description,
            parameters: tool.def.schema,
        }, { type: 'toolCall', id: '', name: tool.def.name, arguments: normalized.value });
        if (runCodeOnly) {
            return {
                ...normalized,
                valid: false,
                error: `${runCodeOnly}\n${runCodeHint(tool.def.name)}`,
            };
        }
        return { ...normalized, valid: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...normalized, valid: false, error: `${message}\n${runCodeHint(tool.def.name)}` };
    }
}
/**
 * The same tool with the repair in front of Pi's validation. Pi keeps one
 * resolved tool per name for a batch, so this depends on the arguments only.
 */
export function withDirectCallArguments(tool) {
    return {
        ...tool,
        def: {
            ...tool.def,
            prepareArguments: (args) => {
                const prepared = prepareDirectCallArguments(tool, args);
                if (prepared.error !== undefined)
                    throw new Error(prepared.error);
                return prepared.value;
            },
        },
    };
}
/** English like the other host lines the model reads; same call forms as the v10 rejection. */
function runCodeHint(toolName) {
    return toolName === 'bash'
        ? 'Call it inside run_code instead: await tools.bash({ command: ... }).'
        : `Call it inside run_code instead: await tools[${JSON.stringify(toolName)}]({ ... }).`;
}
function normalizeValue(value, schema, fixes) {
    const options = schemaOptions(schema);
    if (!options || options.length === 0)
        return value;
    const matching = options.filter((option) => hasType(value, option.type));
    // An allowed type is never changed; descend only when one option governs the value.
    if (matching.length > 0) {
        const [only] = matching;
        return matching.length === 1 && only ? normalizeChildren(value, only, fixes) : value;
    }
    const targets = options.filter((option) => option.type !== 'null');
    const [target] = targets;
    return targets.length === 1 && target ? repair(value, target, fixes) : value;
}
/** Single-type alternatives of a schema, or undefined when they cannot be told apart safely. */
function schemaOptions(schema) {
    if (!isPlainObject(schema) || 'allOf' in schema || '$ref' in schema || 'not' in schema) {
        return undefined;
    }
    return schema.anyOf !== undefined || schema.oneOf !== undefined
        ? unionOptions(schema)
        : typeOptions(schema);
}
function unionOptions(schema) {
    const union = schema.anyOf ?? schema.oneOf;
    const mixed = schema.anyOf !== undefined && schema.oneOf !== undefined;
    if (mixed || schema.type !== undefined || !Array.isArray(union))
        return undefined;
    const options = [];
    for (const branch of union) {
        const nested = schemaOptions(branch);
        if (!nested)
            return undefined;
        options.push(...nested);
    }
    return options;
}
function typeOptions(schema) {
    const types = schema.type;
    if (typeof types === 'string')
        return [{ type: types, schema }];
    if (!Array.isArray(types) || !types.every((type) => typeof type === 'string'))
        return undefined;
    return types.map((type) => ({ type, schema }));
}
function repair(value, option, fixes) {
    if (option.type === 'array')
        return repairItemWrapper(value, option, fixes);
    if (option.type === 'number' || option.type === 'integer') {
        return repairNumberString(value, option.type === 'integer', fixes);
    }
    if (option.type === 'boolean')
        return repairBooleanString(value, fixes);
    return value;
}
function repairItemWrapper(value, option, fixes) {
    if (!isPlainObject(value) || Object.keys(value).length !== 1 || !('item' in value))
        return value;
    fixes.add('item_wrapper');
    return normalizeChildren(Array.isArray(value.item) ? value.item : [value.item], option, fixes);
}
function repairNumberString(value, integer, fixes) {
    if (typeof value !== 'string' || !DECIMAL.test(value))
        return value;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)))
        return value;
    fixes.add('number_string');
    return parsed;
}
function repairBooleanString(value, fixes) {
    if (value !== 'true' && value !== 'false')
        return value;
    fixes.add('boolean_string');
    return value === 'true';
}
/** Repairs object properties and array items; copies a container only when a child changed. */
function normalizeChildren(value, option, fixes) {
    if (option.type === 'object')
        return normalizeProperties(value, option.schema.properties, fixes);
    if (option.type === 'array')
        return normalizeItems(value, option.schema.items, fixes);
    return value;
}
function normalizeProperties(value, properties, fixes) {
    if (!isPlainObject(value) || !isPlainObject(properties))
        return value;
    let next;
    for (const [key, propertySchema] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, key))
            continue;
        const current = value[key];
        const normalized = normalizeValue(current, propertySchema, fixes);
        if (normalized === current)
            continue;
        next ??= { ...value };
        next[key] = normalized;
    }
    return next ?? value;
}
/** Only one item schema for every element; tuple forms are left alone. */
function normalizeItems(value, items, fixes) {
    if (!Array.isArray(value) || !isPlainObject(items))
        return value;
    let next;
    value.forEach((item, index) => {
        const normalized = normalizeValue(item, items, fixes);
        if (normalized === item)
            return;
        next ??= [...value];
        next[index] = normalized;
    });
    return next ?? value;
}
function hasType(value, type) {
    switch (type) {
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'string':
            return typeof value === 'string';
        case 'null':
            return value === null;
        case 'array':
            return Array.isArray(value);
        case 'object':
            return isPlainObject(value);
        default:
            return false;
    }
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=direct-call-arguments.js.map