/**
 * Canonical serialisation of a policy document.
 *
 * Key order is fixed here and list order is fixed by the parser, so the same policy always
 * produces the same bytes — which is what makes the matcher versions stable identifiers rather
 * than incidental hashes of object construction order.
 */
export function canonicalPolicyJson(policy) {
    return JSON.stringify({
        schema_version: policy.schema_version,
        workspace: { exclude_globs: policy.workspace.exclude_globs },
        path_commands: {
            exclude_extensions: policy.path_commands.exclude_extensions,
            exclude_name_globs: policy.path_commands.exclude_name_globs,
            max_commands: policy.path_commands.max_commands,
            max_bytes: policy.path_commands.max_bytes,
        },
        environment: { exclude_keys: policy.environment.exclude_keys },
        metadata: { exclude_fields: policy.metadata.exclude_fields },
    });
}
/**
 * Workspace consumers rebuild indexes when their rules change, so their version must not move
 * when an unrelated PATH limit does.
 */
export function canonicalWorkspaceJson(policy) {
    return JSON.stringify({
        schema_version: policy.schema_version,
        workspace: { exclude_globs: policy.workspace.exclude_globs },
    });
}
//# sourceMappingURL=canonical.js.map