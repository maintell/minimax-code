export const INTERNAL_TURN_ID_PREFIX = 'mavis-internal:';
const LEGACY_SERVER_OWNED_TURN_ID_PREFIXES = [
    'plan-enter:',
    'plan-review:',
    'plan-review-feedback:',
];
export function createInternalTurnId(scope, id) {
    return `${INTERNAL_TURN_ID_PREFIX}${scope}:${id}`;
}
/** Public callers must not mint identities owned by runtime workflows. */
export function isServerOwnedTurnId(value) {
    return (value.startsWith(INTERNAL_TURN_ID_PREFIX) ||
        LEGACY_SERVER_OWNED_TURN_ID_PREFIXES.some((prefix) => value.startsWith(prefix)));
}
//# sourceMappingURL=turn-identity.js.map