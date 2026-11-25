import { z } from 'zod';
const childTargets = new WeakMap();
const childToolNames = new Set();
/** Binds a mavis_* tool definition to the mavis call run_code runs it as. */
export function registerPtcMavisChildTarget(def, target) {
    childTargets.set(def, target);
    childToolNames.add(def.name);
}
/** The mavis call a mavis_* run_code tool stands for; undefined for every other tool. */
export function readPtcMavisChildTarget(tool) {
    return childTargets.get(tool.def);
}
/**
 * True for a name some split in this process registered as a mavis_* run_code
 * tool. Name-based, for the metric `tool` label, which only has the name.
 */
export function isRegisteredPtcMavisChildToolName(name) {
    return childToolNames.has(name);
}
/** The call a model writes inside run_code for a flattened command. */
export function ptcMavisRunCodeCall(toolName, args = '{ ... }') {
    return `await tools.${toolName}(${args})`;
}
/** A mavis_* tool never runs as itself; only run_code runs it as its mavis call. */
export function refusedPtcMavisChildExecution(name, command) {
    const text = JSON.stringify({
        ok: false,
        command,
        error: {
            kind: 'validation',
            code: 'PTC_MAVIS_RUN_CODE_ONLY',
            message: `${name} runs only inside run_code: ${ptcMavisRunCodeCall(name)}.`,
        },
    });
    return { tool_name: name, text, content: [{ type: 'text', text }], isError: true };
}
/**
 * The run_code tool standing for one mavis command: the mavis tool's own
 * execution mode and source, an execute that only refuses, and the target
 * binding run_code resolves the call through.
 */
export function createPtcMavisChildTool(mavis, definition) {
    const def = {
        name: definition.name,
        description: definition.description,
        schema: definition.schema,
        ...(mavis.def.executionMode ? { executionMode: mavis.def.executionMode } : {}),
    };
    registerPtcMavisChildTarget(def, { command: definition.command, tool: mavis });
    return {
        def,
        impl: {
            execute: async () => refusedPtcMavisChildExecution(definition.name, definition.command),
        },
        ...(mavis.source !== undefined ? { source: mavis.source } : {}),
    };
}
/** Adds each argument's line to the top-level object, or to every branch of a top-level union. */
export function describeProperties(schema, toolName, fields) {
    const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
    for (const branch of branches) {
        const properties = branch.properties;
        for (const [key, property] of Object.entries(properties ?? {})) {
            const description = fields[key];
            if (!description)
                throw new Error(`${toolName}: argument ${key} has no description`);
            property.description = description;
        }
    }
    return schema;
}
/**
 * zod (v3) to JSON Schema for exactly the constructs of the mavis command
 * schemas. Anything else throws, so a schema change that this cannot express
 * fails the unit test instead of drifting from what the executor accepts.
 * Refinements (cross-field rules such as mcp update's) cannot be expressed;
 * the tool description states them and the executor still enforces them.
 */
export function zodToJsonSchema(schema) {
    if (schema instanceof z.ZodEffects) {
        if (schema._def.effect.type !== 'refinement')
            throw unsupported('a transform');
        return zodToJsonSchema(schema._def.schema);
    }
    if (schema instanceof z.ZodObject)
        return objectSchema(schema);
    if (schema instanceof z.ZodString)
        return stringSchema(schema);
    if (schema instanceof z.ZodNumber)
        return numberSchema(schema);
    if (schema instanceof z.ZodBoolean)
        return { type: 'boolean' };
    if (schema instanceof z.ZodNull)
        return { type: 'null' };
    if (schema instanceof z.ZodEnum)
        return { type: 'string', enum: [...schema.options] };
    if (schema instanceof z.ZodLiteral)
        return { const: schema.value };
    if (schema instanceof z.ZodArray)
        return { type: 'array', items: zodToJsonSchema(schema.element) };
    if (schema instanceof z.ZodRecord) {
        if (!(schema.keySchema instanceof z.ZodString))
            throw unsupported('a non-string record key');
        return { type: 'object', additionalProperties: zodToJsonSchema(schema.valueSchema) };
    }
    if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
        const options = schema.options;
        return { anyOf: options.map((option) => zodToJsonSchema(option)) };
    }
    throw unsupported(schema.constructor.name);
}
function objectSchema(schema) {
    if (!(schema._def.catchall instanceof z.ZodNever))
        throw unsupported('an object catchall');
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(schema.shape)) {
        const field = value;
        const optional = field instanceof z.ZodOptional;
        properties[key] = zodToJsonSchema(optional ? field.unwrap() : field);
        if (!optional)
            required.push(key);
    }
    // zod strips unknown keys of a non-strict object, so they are accepted, not rejected.
    return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(schema._def.unknownKeys === 'strict' ? { additionalProperties: false } : {}),
    };
}
function stringSchema(schema) {
    const result = { type: 'string' };
    for (const check of schema._def.checks) {
        if (check.kind === 'min')
            result.minLength = check.value;
        else if (check.kind === 'max')
            result.maxLength = check.value;
        // A transform, not a constraint: JSON Schema has no way to say it, and the
        // executor still trims. The argument's own line says so where it matters.
        else if (check.kind === 'trim')
            continue;
        else
            throw unsupported(`string check ${check.kind}`);
    }
    return result;
}
function numberSchema(schema) {
    const result = { type: 'number' };
    for (const check of schema._def.checks) {
        if (check.kind === 'int')
            result.type = 'integer';
        else if (check.kind === 'min')
            result[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        else if (check.kind === 'max')
            result[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
        else
            throw unsupported(`number check ${check.kind}`);
    }
    return result;
}
function unsupported(construct) {
    return new Error(`zodToJsonSchema: ${construct} is not supported`);
}
//# sourceMappingURL=ptc-mavis-child.js.map