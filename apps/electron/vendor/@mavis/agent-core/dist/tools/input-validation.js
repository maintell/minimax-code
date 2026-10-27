import { Kind } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Compile } from 'typebox/compile';
import * as Schema from 'typebox/schema';
const validators = new WeakMap();
const JSON_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const KEYWORD_GUARDS = {
    type: Schema.IsType,
    required: Schema.IsRequired,
    $ref: Schema.IsRef,
    $defs: Schema.IsDefs,
    $id: Schema.IsId,
    $anchor: Schema.IsAnchor,
    $dynamicRef: Schema.IsDynamicRef,
    $dynamicAnchor: Schema.IsDynamicAnchor,
    $recursiveRef: Schema.IsRecursiveRef,
    $recursiveAnchor: Schema.IsRecursiveAnchor,
    properties: Schema.IsProperties,
    patternProperties: Schema.IsPatternProperties,
    additionalProperties: Schema.IsAdditionalProperties,
    propertyNames: Schema.IsPropertyNames,
    dependencies: Schema.IsDependencies,
    dependentRequired: Schema.IsDependentRequired,
    dependentSchemas: Schema.IsDependentSchemas,
    additionalItems: Schema.IsAdditionalItems,
    items: Schema.IsItems,
    prefixItems: Schema.IsPrefixItems,
    contains: Schema.IsContains,
    allOf: Schema.IsAllOf,
    anyOf: Schema.IsAnyOf,
    oneOf: Schema.IsOneOf,
    not: Schema.IsNot,
    if: Schema.IsIf,
    then: Schema.IsThen,
    else: Schema.IsElse,
    unevaluatedItems: Schema.IsUnevaluatedItems,
    unevaluatedProperties: Schema.IsUnevaluatedProperties,
    enum: Schema.IsEnum,
    const: Schema.IsConst,
    minimum: Schema.IsMinimum,
    maximum: Schema.IsMaximum,
    exclusiveMinimum: Schema.IsExclusiveMinimum,
    exclusiveMaximum: Schema.IsExclusiveMaximum,
    multipleOf: Schema.IsMultipleOf,
    minLength: Schema.IsMinLength,
    maxLength: Schema.IsMaxLength,
    minItems: Schema.IsMinItems,
    maxItems: Schema.IsMaxItems,
    minContains: Schema.IsMinContains,
    maxContains: Schema.IsMaxContains,
    minProperties: Schema.IsMinProperties,
    maxProperties: Schema.IsMaxProperties,
    uniqueItems: Schema.IsUniqueItems,
    pattern: Schema.IsPattern,
    format: Schema.IsFormat,
};
const SCHEMA_MAPS = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
]);
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_VALUES = new Set([
    'additionalProperties',
    'propertyNames',
    'additionalItems',
    'items',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'unevaluatedItems',
    'unevaluatedProperties',
]);
/** Checks the exact execution value; validation never coerces values or applies defaults. */
export function validateRuntimeToolInput(schema, value) {
    try {
        if (Schema.IsSchemaObject(schema) && Kind in schema) {
            const native = schema;
            if (Value.Check(native, value))
                return { valid: true };
            return {
                valid: false,
                reason: 'invalid',
                issues: [...Value.Errors(native, value)]
                    .slice(0, 8)
                    .map((issue) => `${issue.path}: ${issue.message}`),
            };
        }
        if (!Schema.IsSchema(schema))
            return unsupported();
        let validator = typeof schema === 'object' ? validators.get(schema) : undefined;
        if (!validator) {
            // The compiler ignores malformed keywords. Validate their shapes before compiling.
            if (!isCompilableSchema(schema))
                return unsupported();
            validator = Compile(schema);
            if (typeof schema === 'object')
                validators.set(schema, validator);
        }
        if (validator.Check(value))
            return { valid: true };
        return {
            valid: false,
            reason: 'invalid',
            issues: validator
                .Errors(value)
                .slice(0, 8)
                .map((issue) => `${issue.instancePath}: ${issue.message}`),
        };
    }
    catch {
        return unsupported();
    }
}
/** Revalidates a Hook-rewritten input against the authoritative runtime tool schema. */
export function isRuntimeToolInputValid(tools, toolName, value) {
    const tool = tools.find((candidate) => candidate.def.name === toolName);
    return Boolean(tool && validateRuntimeToolInput(tool.def.schema, value).valid);
}
function unsupported() {
    return { valid: false, reason: 'unsupported', issues: [] };
}
function isCompilableSchema(root) {
    const visited = new WeakSet();
    const visit = (schema, base) => {
        if (!Schema.IsSchema(schema))
            return false;
        if (typeof schema === 'boolean')
            return true;
        if (visited.has(schema))
            return true;
        visited.add(schema);
        const resolutionBase = Schema.IsId(schema) ? schema : base;
        for (const [keyword, value] of Object.entries(schema)) {
            const guard = Object.hasOwn(KEYWORD_GUARDS, keyword) ? KEYWORD_GUARDS[keyword] : undefined;
            if (guard && !guard(schema))
                return false;
            if (keyword === 'type') {
                const types = Array.isArray(value) ? value : [value];
                if (types.length === 0 || !types.every((type) => JSON_TYPES.has(type)))
                    return false;
            }
            else if (SCHEMA_MAPS.has(keyword)) {
                if (!Schema.IsSchemaObject(value) ||
                    !Object.values(value).every((child) => visit(child, resolutionBase)))
                    return false;
            }
            else if (SCHEMA_ARRAYS.has(keyword) || (keyword === 'items' && Array.isArray(value))) {
                if (!Array.isArray(value) || !value.every((child) => visit(child, resolutionBase)))
                    return false;
            }
            else if (SCHEMA_VALUES.has(keyword)) {
                if (!visit(value, resolutionBase))
                    return false;
            }
            else if (keyword === 'dependencies') {
                if (!Object.values(value).every((child) => Array.isArray(child) || visit(child, resolutionBase)))
                    return false;
            }
            else if (keyword === '$ref' || keyword === '$dynamicRef' || keyword === '$recursiveRef') {
                const target = Schema.IsSchemaObject(resolutionBase)
                    ? Schema.Resolve.Ref(resolutionBase, value)
                    : undefined;
                const resolved = target ?? (Schema.IsSchemaObject(root) ? Schema.Resolve.Ref(root, value) : undefined);
                if (!Schema.IsSchema(resolved) || !visit(resolved, resolutionBase))
                    return false;
            }
        }
        return true;
    };
    return visit(root, root);
}
//# sourceMappingURL=input-validation.js.map