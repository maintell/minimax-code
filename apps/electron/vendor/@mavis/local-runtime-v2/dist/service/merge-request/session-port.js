/**
 * Lets those surfaces reach the service once it exists. Unbound, as with the
 * reviewStatus beta off, it records nothing and knows of no merge request.
 */
export function createDeferredMergeRequestPort() {
    let current;
    return {
        port: {
            recordCommand: async (sessionId, command, output) => {
                await current?.recordCommand(sessionId, command, output);
            },
            peekBranch: async (workspaceDir, branch) => current?.peekBranch(workspaceDir, branch),
        },
        bind: (owner) => {
            current = owner;
            return () => {
                if (current === owner)
                    current = undefined;
            };
        },
    };
}
//# sourceMappingURL=session-port.js.map