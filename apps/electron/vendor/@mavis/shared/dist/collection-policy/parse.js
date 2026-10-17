/**
 * Strict, bounded parser for the remote collection policy document.
 *
 * The parser is deliberately unforgiving: a malformed document returns `undefined` so the caller
 * keeps its last valid policy (or the built-in default) instead of silently collecting under an
 * empty ruleset. Absence — `undefined`, `null` or an empty string — is not malformed and yields
 * the built-in default. Every list, string, number and glob is bounded before anything is
 * compiled or matched.
 */
import { canonicalPolicyJson } from './canonical.js';
import { DEFAULT_COLLECTION_POLICY, DEFAULT_MAX_PATH_COMMANDS, DEFAULT_MAX_PATH_COMMAND_BYTES, EXCLUDABLE_METADATA_FIELDS, READABLE_ENVIRONMENT_KEYS, } from './defaults.js';
import { NAME_GLOB_LIMITS, WORKSPACE_GLOB_LIMITS, normalizeGlob } from './glob.js';
import { COLLECTION_POLICY_SCHEMA_VERSION, } from './types.js';
const MAX_POLICY_JSON_LENGTH = 32 << 10;
const MAX_WORKSPACE_GLOBS = 256;
const MAX_PATH_EXTENSIONS = 256;
const MAX_PATH_NAME_GLOBS = 256;
const MAX_ENVIRONMENT_KEYS = 64;
const MAX_METADATA_FIELDS = 64;
const MAX_PATH_COMMANDS_LIMIT = 10_000;
const MAX_PATH_BYTES_LIMIT = 1 << 20;
const EXTENSION_PATTERN = /^\.[a-z0-9][a-z0-9+-]{0,15}$/u;
const POLICY_KEYS = {
    schema_version: true,
    workspace: true,
    path_commands: true,
    environment: true,
    metadata: true,
};
const WORKSPACE_KEYS = { exclude_globs: true };
const PATH_COMMAND_KEYS = {
    exclude_extensions: true,
    exclude_name_globs: true,
    max_commands: true,
    max_bytes: true,
};
const ENVIRONMENT_KEYS = { exclude_keys: true };
const METADATA_KEYS = { exclude_fields: true };
const EMPTY_LIST = Object.freeze([]);
/**
 * Parses an unknown Apollo value into a complete policy. Returns `undefined` when the document
 * exists but is invalid, and the built-in default when it is absent.
 */
export function parseCollectionPolicy(input) {
    if (input === undefined || input === null)
        return DEFAULT_COLLECTION_POLICY;
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.length === 0)
            return DEFAULT_COLLECTION_POLICY;
        if (trimmed.length > MAX_POLICY_JSON_LENGTH)
            return undefined;
        let decoded;
        try {
            decoded = JSON.parse(trimmed);
        }
        catch {
            return undefined;
        }
        if (decoded === null)
            return DEFAULT_COLLECTION_POLICY;
        if (typeof decoded === 'string')
            return undefined;
        return parsePolicyDocument(decoded);
    }
    return parsePolicyDocument(input);
}
/**
 * Narrows to a policy only when the value is already the complete canonical form the parser
 * produces: every field present, every list bounded, normalised, de-duplicated and sorted. A
 * partial document such as `{}` is a valid parser input but is not a `CollectionPolicy`.
 */
export function isCollectionPolicy(input) {
    if (!isCompletePolicyDocument(input))
        return false;
    const parsed = parseCollectionPolicy(input);
    return parsed !== undefined && canonicalPolicyJson(parsed) === canonicalPolicyJson(input);
}
function parsePolicyDocument(value) {
    const document = readObject(value, POLICY_KEYS);
    if (!document)
        return undefined;
    const schemaVersion = document.schema_version ?? COLLECTION_POLICY_SCHEMA_VERSION;
    if (schemaVersion !== COLLECTION_POLICY_SCHEMA_VERSION)
        return undefined;
    const workspace = parseWorkspaceRules(document.workspace);
    const pathCommands = parsePathCommandRules(document.path_commands);
    const environment = parseEnvironmentRules(document.environment);
    const metadata = parseMetadataRules(document.metadata);
    if (!workspace || !pathCommands || !environment || !metadata)
        return undefined;
    return Object.freeze({
        schema_version: COLLECTION_POLICY_SCHEMA_VERSION,
        workspace,
        path_commands: pathCommands,
        environment,
        metadata,
    });
}
function parseWorkspaceRules(value) {
    if (value === undefined || value === null)
        return DEFAULT_COLLECTION_POLICY.workspace;
    const rules = readObject(value, WORKSPACE_KEYS);
    if (!rules)
        return undefined;
    const excludeGlobs = parseStringList(rules.exclude_globs, MAX_WORKSPACE_GLOBS, (entry) => normalizeGlob(entry, WORKSPACE_GLOB_LIMITS));
    if (!excludeGlobs)
        return undefined;
    return Object.freeze({ exclude_globs: excludeGlobs });
}
function parsePathCommandRules(value) {
    if (value === undefined || value === null)
        return DEFAULT_COLLECTION_POLICY.path_commands;
    const rules = readObject(value, PATH_COMMAND_KEYS);
    if (!rules)
        return undefined;
    const excludeExtensions = parseStringList(rules.exclude_extensions, MAX_PATH_EXTENSIONS, normalizeExtension, DEFAULT_COLLECTION_POLICY.path_commands.exclude_extensions);
    const excludeNameGlobs = parseStringList(rules.exclude_name_globs, MAX_PATH_NAME_GLOBS, (entry) => normalizeGlob(entry, NAME_GLOB_LIMITS));
    const maxCommands = parseBoundedInteger(rules.max_commands, MAX_PATH_COMMANDS_LIMIT, DEFAULT_MAX_PATH_COMMANDS);
    const maxBytes = parseBoundedInteger(rules.max_bytes, MAX_PATH_BYTES_LIMIT, DEFAULT_MAX_PATH_COMMAND_BYTES);
    if (!excludeExtensions || !excludeNameGlobs)
        return undefined;
    if (maxCommands === undefined || maxBytes === undefined)
        return undefined;
    return Object.freeze({
        exclude_extensions: excludeExtensions,
        exclude_name_globs: excludeNameGlobs,
        max_commands: maxCommands,
        max_bytes: maxBytes,
    });
}
function parseEnvironmentRules(value) {
    if (value === undefined || value === null)
        return DEFAULT_COLLECTION_POLICY.environment;
    const rules = readObject(value, ENVIRONMENT_KEYS);
    if (!rules)
        return undefined;
    const excludeKeys = parseStringList(rules.exclude_keys, MAX_ENVIRONMENT_KEYS, (entry) => {
        if (typeof entry !== 'string')
            return undefined;
        const key = entry.trim().toUpperCase();
        return Object.hasOwn(READABLE_ENVIRONMENT_KEYS, key) ? key : undefined;
    });
    if (!excludeKeys)
        return undefined;
    return Object.freeze({ exclude_keys: excludeKeys });
}
function parseMetadataRules(value) {
    if (value === undefined || value === null)
        return DEFAULT_COLLECTION_POLICY.metadata;
    const rules = readObject(value, METADATA_KEYS);
    if (!rules)
        return undefined;
    const excludeFields = parseStringList(rules.exclude_fields, MAX_METADATA_FIELDS, (entry) => {
        if (typeof entry !== 'string')
            return undefined;
        const field = entry.trim().toLowerCase();
        return Object.hasOwn(EXCLUDABLE_METADATA_FIELDS, field) ? field : undefined;
    });
    if (!excludeFields)
        return undefined;
    return Object.freeze({ exclude_fields: excludeFields });
}
function readObject(value, allowedKeys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const document = value;
    for (const key of Object.keys(document)) {
        if (!Object.hasOwn(allowedKeys, key))
            return undefined;
    }
    return document;
}
function parseStringList(value, limit, normalize, fallback = EMPTY_LIST) {
    if (value === undefined || value === null)
        return fallback;
    if (!Array.isArray(value) || value.length > limit)
        return undefined;
    const normalized = [];
    for (const entry of value) {
        const canonical = normalize(entry);
        if (canonical === undefined)
            return undefined;
        normalized.push(canonical);
    }
    return Object.freeze([...new Set(normalized)].sort());
}
function normalizeExtension(entry) {
    if (typeof entry !== 'string')
        return undefined;
    const trimmed = entry.trim().toLowerCase();
    const extension = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    return EXTENSION_PATTERN.test(extension) ? extension : undefined;
}
function parseBoundedInteger(value, limit, fallback) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value))
        return undefined;
    return value >= 0 && value <= limit ? value : undefined;
}
function isCompletePolicyDocument(value) {
    const document = readObject(value, POLICY_KEYS);
    if (!document || document.schema_version !== COLLECTION_POLICY_SCHEMA_VERSION)
        return false;
    const workspace = readObject(document.workspace, WORKSPACE_KEYS);
    const pathCommands = readObject(document.path_commands, PATH_COMMAND_KEYS);
    const environment = readObject(document.environment, ENVIRONMENT_KEYS);
    const metadata = readObject(document.metadata, METADATA_KEYS);
    if (!workspace || !pathCommands || !environment || !metadata)
        return false;
    return (isStringArray(workspace.exclude_globs) &&
        isStringArray(pathCommands.exclude_extensions) &&
        isStringArray(pathCommands.exclude_name_globs) &&
        Number.isInteger(pathCommands.max_commands) &&
        Number.isInteger(pathCommands.max_bytes) &&
        isStringArray(environment.exclude_keys) &&
        isStringArray(metadata.exclude_fields));
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
//# sourceMappingURL=parse.js.map