/** The one late binding of the coordinator extension: the Host reads it, the composition binds it. */
export function createCoordinatorExtensionSlot() {
    let bound;
    return {
        read: () => bound,
        bind: (extension) => {
            bound = extension;
        },
    };
}
//# sourceMappingURL=coordinator-extension.js.map