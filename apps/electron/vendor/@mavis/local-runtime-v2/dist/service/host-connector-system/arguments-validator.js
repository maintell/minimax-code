import { Compile } from 'typebox/compile';
const MAX_DIAGNOSTIC_ISSUES = 4;
const MAX_DIAGNOSTIC_PATH_BYTES = 256;
/**
 * Compiles the provider schema once for this inventory revision. Schemas that
 * this TypeBox engine cannot compile remain provider-owned and fail open here.
 */
export function compileConnectorArgumentsValidator(inputSchemaJson) {
    try {
        const schema = JSON.parse(inputSchemaJson);
        if (!isRecord(schema))
            return undefined;
        const validator = Compile(schema);
        return Object.freeze({
            validate: (value) => validate(validator, value),
        });
    }
    catch {
        return undefined;
    }
}
function validate(validator, value) {
    try {
        if (validator.Check(value))
            return undefined;
        return Object.freeze(projectIssues(validator.Errors(value), value));
    }
    catch {
        return undefined;
    }
}
function projectIssues(errors, value) {
    const issues = [];
    for (const error of errors) {
        if (error.keyword === 'required') {
            appendRequiredIssues(issues, value, error.instancePath, error.params.requiredProperties);
            if (issues.length === MAX_DIAGNOSTIC_ISSUES)
                return issues;
            continue;
        }
        const limit = readFiniteLimit(error.params);
        issues.push(freezeIssue({
            path: resolveInstancePath(value, error.instancePath),
            constraint: safeConstraint(error.keyword),
            ...(limit === undefined ? {} : { limit }),
        }));
        if (issues.length === MAX_DIAGNOSTIC_ISSUES)
            return issues;
    }
    return issues;
}
function appendRequiredIssues(issues, value, instancePath, requiredProperties) {
    for (const property of requiredProperties) {
        issues.push(freezeIssue({ path: requiredPath(value, instancePath, property), constraint: 'required' }));
        if (issues.length === MAX_DIAGNOSTIC_ISSUES)
            return;
    }
}
function requiredPath(value, instancePath, property) {
    const parentTokens = resolveInstancePathTokens(value, instancePath);
    if (!parentTokens || containsControlCharacter(property))
        return '';
    return pointerFromTokens([...parentTokens, property]);
}
function resolveInstancePath(value, instancePath) {
    const tokens = resolveInstancePathTokens(value, instancePath);
    return tokens ? pointerFromTokens(tokens) : '';
}
function resolveInstancePathTokens(value, instancePath) {
    if (instancePath === '')
        return [];
    if (!instancePath.startsWith('/') || containsControlCharacter(instancePath))
        return undefined;
    const candidates = [];
    collectPathCandidates(value, instancePath, [], candidates);
    return candidates.length === 1 ? candidates[0] : undefined;
}
function collectPathCandidates(value, remainingPath, tokens, candidates) {
    if (candidates.length > 1 || !isObject(value))
        return;
    for (const key of Object.keys(value)) {
        const prefix = `/${key}`;
        if (remainingPath === prefix) {
            candidates.push([...tokens, key]);
        }
        else if (remainingPath.startsWith(`${prefix}/`)) {
            collectPathCandidates(value[key], remainingPath.slice(prefix.length), [...tokens, key], candidates);
        }
        if (candidates.length > 1)
            return;
    }
}
function safeConstraint(keyword) {
    return /^[A-Za-z0-9_.~-]+$/u.test(keyword) && Buffer.byteLength(keyword) <= 64
        ? keyword
        : 'schema';
}
function readFiniteLimit(params) {
    const value = params.limit;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function freezeIssue(issue) {
    return Object.freeze(issue);
}
function escapeJsonPointerToken(value) {
    return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}
function pointerFromTokens(tokens) {
    if (tokens.some(containsControlCharacter))
        return '';
    const path = tokens.length === 0 ? '' : `/${tokens.map(escapeJsonPointerToken).join('/')}`;
    return Buffer.byteLength(path) <= MAX_DIAGNOSTIC_PATH_BYTES ? path : '';
}
function containsControlCharacter(value) {
    return /[\u0000-\u001f\u007f]/u.test(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=arguments-validator.js.map