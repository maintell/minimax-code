export function isWorkspaceIndexingSessionEligible(input) {
    // Upload only when the daemon has positively identified a user-selected
    // Project. Older/migrated records may not carry this field, so treating
    // `undefined` as eligible could capture the application's fallback folder.
    return input.isDefaultWorkspace === false;
}
//# sourceMappingURL=preference.js.map