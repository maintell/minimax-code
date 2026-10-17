/**
 * Ask-policy + proposed-rule types for the permission decision flow.
 *
 *   PermissionMode (UI / config wire)  ──modeToAskPolicy──▶  AskForApproval
 *
 * `AskForApproval` is the internal policy the facade branches on; `ProposedRule`
 * is the optional rule suggestion a decision can carry (engine-derived, or
 * reserved on a cloud-gateway `allow` verdict).
 */
/**
 * Adapter: `PermissionMode` (UI / config wire) → `AskForApproval` (internal
 * decision policy). The facade translates once near the top of its check so the
 * rest of the flow never branches on PermissionMode directly.
 */
export function modeToAskPolicy(mode) {
    switch (mode) {
        case 'bypassPermissions':
        case 'off':
            return 'never';
        case 'auto':
            return 'on-request-llm';
        case 'dontAsk':
            return 'deny';
        case 'default':
        case 'acceptEdits':
            // acceptEdits is an alias for default + pre-seeded edit/write allow rules;
            // the alias seeding runs at startup, the runtime treats the mode as default.
            return 'on-request';
        default: {
            // exhaustiveness guard
            const _exhaustive = mode;
            void _exhaustive;
            return 'on-request';
        }
    }
}
//# sourceMappingURL=ask-policy.js.map