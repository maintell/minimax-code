import { randomBytes } from 'node:crypto';
import { isTrustedBuiltinCreationSource, resolveCanonicalSubagentRole, } from '@mavis/agent-tools/desktop/subagent-roles';
import { AgentServiceError } from '../errors.js';
export const PRIMARY_AGENT_NAME = 'mavis';
export const LEGACY_PRIMARY_AGENT_NAME = 'main';
export function buildAgentReadScope(primaryAgentName, input) {
    return {
        requestedName: input.requestedName,
        canonicalName: input.canonicalName,
        primaryName: primaryAgentName,
        compatibleNames: input.compatibleNames,
        exact: input.exact,
        source: input.source,
        exactOwnerName: input.exactOwnerName,
        ...(input.ownerMeta
            ? { trustedBuiltin: isTrustedBuiltinCreationSource(input.ownerMeta.creationSource) }
            : {}),
    };
}
const MAX_AGENT_NAME_LENGTH = 64;
const STRICT_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const WINDOWS_RESERVED_AGENT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
function validateNewAgentName(name) {
    const validated = validateLookupName(name);
    if (!STRICT_AGENT_NAME_PATTERN.test(validated)) {
        throw new AgentServiceError('AGENT_NAME_INVALID', 'Agent name must start with a lowercase letter and contain only lowercase letters, digits, hyphens, or underscores.');
    }
    return validated;
}
export function resolveCreatedAgentName(name) {
    return name === undefined || name.trim().length === 0
        ? `agent-${randomBytes(6).toString('hex')}`
        : validateNewAgentName(name);
}
export function validateCreateInput(input, name) {
    const displayName = input.initialDefinition?.mavis?.displayName ?? input.displayName;
    if (displayName !== undefined && (!displayName || displayName.trim() === '')) {
        throw new AgentServiceError('VALIDATION_ERROR', 'display_name cannot be empty');
    }
    if (isReservedName(name)) {
        throw new AgentServiceError('AGENT_ROLE_CONFLICT', `Agent name "${name}" is reserved; use a collision-safe custom name.`);
    }
}
export function validateUpdateInput(input) {
    if (input.displayName !== undefined &&
        input.displayName !== null &&
        input.displayName.trim() === '') {
        throw new AgentServiceError('VALIDATION_ERROR', 'display_name cannot be empty');
    }
}
export function validateUpdateAgainstMeta(input, constraints) {
    if (constraints.builtin && (input.persona !== undefined || input.systemPrompt !== undefined)) {
        throw new AgentServiceError('BUILTIN_AGENT_IMMUTABLE', 'Built-in Agent templates are immutable.');
    }
    if (constraints.primary &&
        input.displayName !== undefined &&
        constraints.primaryDisplayName !== undefined &&
        input.displayName !== constraints.primaryDisplayName) {
        throw new AgentServiceError('PRIMARY_AGENT_IMMUTABLE', 'Primary Agent display name is immutable.');
    }
}
export function toAgentInsert(input, name, now) {
    const initialDefinition = input.initialDefinition;
    return {
        name,
        agentRole: input.agentRole ?? 'worker',
        creationSource: 'manual',
        ...createRuntimeInsertFields(input, name),
        ...(initialDefinition === undefined
            ? legacyCreateInsertFields(input)
            : initialDefinitionInsertFields(input, initialDefinition)),
        createdAtMs: now,
        updatedAtMs: now,
    };
}
function createRuntimeInsertFields(input, name) {
    const mavis = input.initialDefinition?.mavis;
    const defaultWorkspaceDir = mavis?.defaultWorkspaceDir ?? input.defaultWorkspaceDir;
    return {
        ...(input.rootSessionId === undefined ? {} : { rootSessionId: input.rootSessionId }),
        ...(defaultWorkspaceDir === undefined ? {} : { defaultWorkspaceDir }),
        displayName: mavis?.displayName ?? input.displayName ?? name,
    };
}
function legacyCreateInsertFields(input) {
    return {
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
        ...(input.persona === undefined ? {} : { persona: input.persona }),
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    };
}
function initialDefinitionInsertFields(input, initialDefinition) {
    const avatar = initialDefinition.mavis?.avatar ?? input.avatar;
    return {
        // Canonical publication filters this definition and writes `insert.name`
        // as the only durable owner name. Keep the presentation object separate so
        // request-only fields cannot choose another Agent directory.
        initialDefinition,
        description: initialDefinition.description,
        ...(avatar === undefined ? {} : { avatar }),
        systemPrompt: initialDefinition.systemPrompt,
    };
}
export function toAgentAssetsUpdate(input, name, now) {
    return {
        name,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
        ...(input.persona === undefined ? {} : { persona: input.persona }),
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        ...(input.defaultWorkspaceDir === undefined
            ? {}
            : { defaultWorkspaceDir: input.defaultWorkspaceDir }),
        updatedAtMs: now,
    };
}
export function validateLookupName(name) {
    const trimmed = name.trim();
    if (!trimmed)
        throw new AgentServiceError('AGENT_NAME_REQUIRED', 'Agent name is required.');
    if (hasInvalidLookupNameShape(name, trimmed)) {
        throw new AgentServiceError('AGENT_NAME_INVALID', 'Agent name contains invalid characters.');
    }
    return trimmed;
}
function hasInvalidLookupNameShape(name, trimmed) {
    return (trimmed !== name ||
        trimmed.length > MAX_AGENT_NAME_LENGTH ||
        trimmed.includes('/') ||
        trimmed.includes('\\') ||
        trimmed === '.' ||
        trimmed === '..' ||
        trimmed.endsWith('.') ||
        WINDOWS_RESERVED_AGENT_NAMES.test(trimmed) ||
        /[\u0000-\u001f\u007f]/u.test(trimmed));
}
export function normalizeRequestRef(ref) {
    const trimmed = ref.trim();
    if (!trimmed)
        throw new AgentServiceError('AGENT_REQUEST_REF_INVALID', 'Agent requestRef is required.');
    if (trimmed.toLowerCase().startsWith('agent:')) {
        return `agent:${validateLookupName(trimmed.slice('agent:'.length))}`;
    }
    return validateLookupName(trimmed);
}
export function isReservedName(name) {
    return (name === PRIMARY_AGENT_NAME ||
        name === LEGACY_PRIMARY_AGENT_NAME ||
        resolveCanonicalSubagentRole(name) !== undefined);
}
export function notFound(name) {
    return new AgentServiceError('AGENT_NOT_FOUND', `Agent not found: ${name}`);
}
export function parseExplicitName(requestRef) {
    if (!requestRef.toLowerCase().startsWith('agent:'))
        return undefined;
    const exact = requestRef.slice('agent:'.length);
    if (!exact)
        throw new AgentServiceError('AGENT_NAME_REQUIRED', 'Agent name is required.');
    return validateLookupName(exact);
}
export function parseExplicitNameOrStable(requestRef) {
    const normalized = requestRef.trim();
    const explicit = parseExplicitName(normalized);
    return explicit ?? validateLookupName(normalized);
}
export function canonicalAgentNotAvailableError(requestedName, replacement) {
    return new AgentServiceError('CANONICAL_AGENT_NOT_AVAILABLE', `Agent "${requestedName}" cannot execute because canonical Agent "${replacement}" is unavailable`, undefined, { requestedName, replacement });
}
export function builtinNameConflictError(requestedName, canonicalName, candidate) {
    return new AgentServiceError('BUILTIN_AGENT_NAME_CONFLICT', `Canonical built-in Agent "${canonicalName}" is occupied by a non-builtin Agent`, undefined, {
        requestedName,
        canonicalName,
        candidate: candidate.name,
        candidates: [candidate.name],
        creationSource: candidate.creationSource,
    });
}
export function resolveActivePrimaryName(metas, primaryAgentName) {
    const find = (name, trustedOnly = false) => metas.find((meta) => meta.name === name && (!trustedOnly || isTrustedBuiltinCreationSource(meta.creationSource)))?.name;
    return (find(primaryAgentName, true) ??
        find(LEGACY_PRIMARY_AGENT_NAME, true) ??
        find(primaryAgentName) ??
        find(LEGACY_PRIMARY_AGENT_NAME) ??
        primaryAgentName);
}
export function isHarnessAgent(meta) {
    return Boolean(meta.sourceProject?.trim() || meta.harnessSourceType?.trim());
}
export function displayNameOrAgentName(displayName, agentName) {
    return displayName?.trim() || agentName;
}
export function normalizeReservedDisplayName(displayName) {
    return displayName.trim().toLowerCase();
}
export function sameDisplayName(left, right) {
    return left.trim() === right.trim();
}
//# sourceMappingURL=names.js.map