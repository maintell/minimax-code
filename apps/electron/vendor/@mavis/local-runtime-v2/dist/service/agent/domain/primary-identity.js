import { AgentServiceError } from '../errors.js';
import { LEGACY_PRIMARY_AGENT_NAME } from './names.js';
function primaryFamilyNames(primaryAgentName) {
    return primaryAgentName === LEGACY_PRIMARY_AGENT_NAME
        ? [primaryAgentName]
        : [primaryAgentName, LEGACY_PRIMARY_AGENT_NAME];
}
export function isPrimaryFamilyName(name, primaryAgentName) {
    return primaryFamilyNames(primaryAgentName).includes(name);
}
export function toPrimaryFamilyMembers(metas, primaryAgentName, isTrustedBuiltin) {
    return primaryFamilyNames(primaryAgentName).flatMap((name) => {
        const meta = metas.find((candidate) => candidate.name === name);
        return meta ? [{ name, trustedBuiltin: isTrustedBuiltin(meta) }] : [];
    });
}
function primaryAgentIdentityConflictError(occupiedNames) {
    return new AgentServiceError('PRIMARY_AGENT_IDENTITY_CONFLICT', `Reserved primary Agent name is occupied by a non-builtin Agent: ${[...occupiedNames]
        .sort()
        .join(', ')}`, undefined, { candidates: [...occupiedNames].sort() });
}
export function legacyPrimaryWriteForbiddenError(requestedName, canonicalName) {
    return new AgentServiceError('LEGACY_PRIMARY_WRITE_FORBIDDEN', `Legacy primary Agent "${requestedName}" is read-only history; write to "${canonicalName}" instead.`, undefined, { requestedName, canonicalName });
}
/**
 * Fail closed when a caller observes an untrusted primary row before the
 * startup provenance repair has adopted the historical built-in identity.
 */
export function assertTrustedPrimaryFamily(members) {
    const occupied = members.filter((member) => !member.trustedBuiltin).map((member) => member.name);
    if (occupied.length > 0)
        throw primaryAgentIdentityConflictError(occupied);
}
/**
 * Resolves the frozen execution owner for a persisted storage owner. Returns
 * `undefined` for every Agent outside the primary family so ordinary Agents
 * keep using their own persisted row.
 */
export function resolvePrimaryExecutionIdentity(input) {
    const { storageOwnerName, primaryAgentName, members } = input;
    if (!isPrimaryFamilyName(storageOwnerName, primaryAgentName))
        return undefined;
    assertTrustedPrimaryFamily(members);
    const canonical = members.find((member) => member.name === primaryAgentName);
    if (canonical) {
        return { storageOwnerName, executionOwnerName: canonical.name, outcome: 'canonical' };
    }
    // Standalone V1 compatibility: no canonical row was ever seeded, so the
    // trusted legacy row is view, storage and execution owner at the same time.
    const legacy = members.find((member) => member.name === LEGACY_PRIMARY_AGENT_NAME);
    if (legacy) {
        return { storageOwnerName, executionOwnerName: legacy.name, outcome: 'legacy_fallback' };
    }
    return undefined;
}
/**
 * One idempotent convergence pass: adopt the legacy row's user-authored profile
 * only while the canonical row is still empty or still equal to the package
 * seed. Persona / system prompt stay on the Mavis builtin package, and
 * Owner / ACL are deliberately out of scope here.
 */
export function planLegacyProfileOverlay(input) {
    const plan = {
        ...(input.primaryDisplayNameLocked
            ? {}
            : overlayField('displayName', input.canonicalIdentity?.displayName, input.legacyIdentity?.displayName, input.seedIdentity.displayName)),
        ...overlayField('description', input.canonicalIdentity?.description, input.legacyIdentity?.description, input.seedIdentity.description),
        ...overlayField('avatar', input.canonicalIdentity?.avatar, input.legacyIdentity?.avatar, input.seedIdentity.avatar),
        ...overlayField('defaultWorkspaceDir', input.canonicalConfig?.defaultWorkspaceDir, input.legacyConfig?.defaultWorkspaceDir, undefined),
    };
    return Object.keys(plan).length === 0 ? undefined : plan;
}
function overlayField(field, canonicalValue, legacyValue, seedDefault) {
    const legacy = legacyValue?.trim();
    const seed = seedDefault?.trim() ?? '';
    if (!legacy || legacy === seed)
        return {};
    const canonical = canonicalValue?.trim() ?? '';
    // A canonical value the user already changed always wins; the legacy row
    // stays as read-only history.
    if (canonical !== '' && canonical !== seed)
        return {};
    return { [field]: legacy };
}
//# sourceMappingURL=primary-identity.js.map