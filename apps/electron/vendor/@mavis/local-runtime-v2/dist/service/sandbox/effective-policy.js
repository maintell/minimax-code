const WORKSPACE_SURFACE = [
    'workspace',
    'git-dir',
    'common-dir',
    'session-temp',
];
/**
 * `workspace_write` still has to let the execution layer move a deleted file
 * into the platform trash, otherwise the product promise "every delete is
 * recoverable" cannot hold inside the cage. Only the *destination* is opened:
 * `unlinkAllowOnly` stays the workspace surface, so the kernel keeps deciding
 * WHICH files may be removed.
 */
const WORKSPACE_SURFACE_WITH_TRASH = [
    ...WORKSPACE_SURFACE,
    'trash',
];
const SESSION_TEMP = ['session-temp'];
const HOST_ROOT = ['host-root'];
/** Pure product-policy compiler. Invocation-specific paths remain symbolic. */
export function compileSandboxEffectivePolicy(config) {
    const scopes = compileFilesystemScopes(config.filesystem.policy.mode);
    const networkMode = config.network.policy.mode;
    return {
        enabled: config.enabled,
        filesystem: {
            mode: config.filesystem.policy.mode,
            allowWrite: [...scopes.allowWrite],
            unlinkAllowOnly: [...scopes.unlinkAllowOnly],
            denyRead: [...config.filesystem.denyRead],
            denyWrite: [...config.filesystem.denyWrite],
        },
        network: {
            mode: networkMode,
            // Desktop policy: the sandbox never restricts network access. Any
            // historical config (deny mode, deniedDomains) is already normalized
            // away at parse time; the compiler pins the zero-restriction IR here so
            // backends can skip their network subsystem entirely.
            enforce: false,
            allowedDomains: [],
            deniedDomains: [],
            strictAllowlist: true,
            allowAll: true,
        },
        localAccess: config.localAccess,
    };
}
/**
 * Narrows one admitted invocation to the existing read-only policy without
 * changing the user-selected global sandbox configuration.
 */
export function withReadOnlyFilesystem(policy) {
    const scopes = compileFilesystemScopes('read_only');
    return {
        ...policy,
        filesystem: {
            ...policy.filesystem,
            mode: 'read_only',
            allowWrite: [...scopes.allowWrite],
            unlinkAllowOnly: [...scopes.unlinkAllowOnly],
        },
    };
}
function compileFilesystemScopes(mode) {
    switch (mode) {
        case 'read_only':
            // No trash destination: a read-only invocation must not delete at all.
            return { allowWrite: SESSION_TEMP, unlinkAllowOnly: SESSION_TEMP };
        case 'workspace_write':
            return { allowWrite: WORKSPACE_SURFACE_WITH_TRASH, unlinkAllowOnly: WORKSPACE_SURFACE };
        case 'delete_guard':
            // host-root write already covers the trash destination.
            return { allowWrite: HOST_ROOT, unlinkAllowOnly: WORKSPACE_SURFACE };
        case 'full_access':
            return { allowWrite: HOST_ROOT, unlinkAllowOnly: HOST_ROOT };
    }
}
//# sourceMappingURL=effective-policy.js.map