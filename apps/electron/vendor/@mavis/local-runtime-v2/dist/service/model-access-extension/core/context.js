import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
/** Where an installation's private data lives: <profile>/model-access/data/<installationId>/. */
export function installationDataDir(root, installationId) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(installationId))
        throw new Error('installation_invalid');
    return path.join(root, 'data', installationId);
}
/** The one place an ExtensionContext is built. */
export function extensionContext(input) {
    return Object.freeze({
        profileId: input.profileId,
        installationId: input.installationId,
        generation: input.generation,
        operationId: input.operationId ?? randomUUID(),
        signal: input.signal,
        enabledTargets: Object.freeze([...(input.enabledTargets ?? [])]),
        policyRevision: input.policyRevision ?? 0,
        dataDir: installationDataDir(input.directories.root, input.installationId),
        hostDataDir: input.directories.hostDataDir,
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        ...(input.updateLoginView ? { updateLoginView: input.updateLoginView } : {}),
    });
}
/**
 * The conversation key an extension sees: sha256 over the installation and the session id, so
 * the raw id never leaves the host and two installations never share a key.
 */
export function extensionSessionKey(installationId, sessionId) {
    return createHash('sha256')
        .update(`mcode-session-v1\0${installationId}\0${sessionId}`)
        .digest('hex')
        .slice(0, 32);
}
/** What an extension is told about a binding: never a secret locator, slot or revision. */
export function accessBinding(binding) {
    const common = {
        providerKey: binding.providerKey,
        installationId: binding.installationId,
        providerId: binding.providerId,
    };
    return binding.kind === 'borrowed-current'
        ? Object.freeze({ ...common, kind: binding.kind, sourceRef: binding.sourceRef })
        : Object.freeze({ ...common, kind: binding.kind });
}
/** A trusted extension's error is judged by its string code only (no instanceof across packages). */
export function errorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
function errorText(error) {
    if (!error || typeof error !== 'object')
        return '';
    const message = error.message;
    return typeof message === 'string' ? message.slice(0, 2048) : '';
}
/** Words a vendor uses when a sign-in itself is gone. */
const REVOKED_WORDS = /invalid_grant|token_revoked|refresh_token_expired|refresh token (has )?expired|revoked|unauthorized_client|invalid_refresh_token/iu;
/** Codes an extension uses for the same thing. */
const REVOKED_CODES = /(^|_)(auth_revoked|reauth_required|signed_out|unauthorized|invalid_credential)$/u;
/** Whether a renewal failure says the sign-in is no longer valid (vs. a network/timeout failure). */
export function signInRevoked(error) {
    const code = errorCode(error);
    if (code && REVOKED_CODES.test(code))
        return true;
    return REVOKED_WORDS.test(errorText(error));
}
//# sourceMappingURL=context.js.map