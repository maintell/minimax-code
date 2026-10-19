/**
 * Provider credentials may name an environment variable instead of carrying the
 * key itself, so a plaintext secret never has to reach config.yaml.
 *
 * A whole-string `${NAME}` reference is resolved when the credential is read, so
 * rotating the key in the environment takes effect without touching the file. The
 * resolved value belongs to the request in flight; nothing in the config write
 * path ever receives it.
 *
 * The accepted form is deliberately narrow. Partial interpolation (`Bearer ${T}`)
 * and the unbraced `$NAME` shorthand stay plaintext, because a partial expansion
 * cannot be rejected at the config boundary without guessing at a prefix rule.
 */
const ENV_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** Environment variable name when `value` is exactly a `${NAME}` reference. */
export function credentialEnvReferenceName(value) {
    if (typeof value !== 'string')
        return undefined;
    return ENV_REFERENCE_PATTERN.exec(value.trim())?.[1];
}
export function resolveProviderCredential(input) {
    const { field, provider, value } = input;
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        throw new Error(`Provider "${provider}": ${field} must be a string or a \`\${NAME}\` environment variable reference, received ${describeConfiguredType(value)}.`);
    }
    const configured = value.trim();
    if (!configured)
        return undefined;
    const envName = credentialEnvReferenceName(configured);
    if (!envName)
        return configured;
    const resolved = (input.env ?? process.env)[envName]?.trim();
    if (!resolved) {
        throw new Error(`Provider "${provider}": ${field} references environment variable "${envName}", which is not set.`);
    }
    return resolved;
}
/**
 * Non-throwing counterpart to {@link resolveProviderCredential}, for call sites
 * that only need to know whether a credential is configured and where it comes
 * from — provider views, connection fingerprints. A missing environment
 * variable reads as "configured but unresolved" here; the strict
 * resolver still reports it when a request is actually made.
 */
export function probeProviderCredential(input) {
    const hasPlain = typeof input.value === 'string' && input.value.trim().length > 0;
    if (!hasPlain)
        return { configured: false };
    const source = isEnvReference(input.value) ? 'env' : 'plaintext';
    try {
        const secret = resolveProviderCredential(input);
        return { configured: true, source, ...(secret ? { secret } : {}) };
    }
    catch {
        return { configured: true, source };
    }
}
function isEnvReference(value) {
    return credentialEnvReferenceName(value) !== undefined;
}
function describeConfiguredType(value) {
    if (Array.isArray(value))
        return 'a list';
    return `a ${typeof value}`;
}
//# sourceMappingURL=credential-reference.js.map