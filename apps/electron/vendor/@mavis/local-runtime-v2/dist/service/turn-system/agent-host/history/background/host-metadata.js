import { hasValidBackgroundTaskHostMetadata, readBackgroundTaskOriginMetadata, } from '../../contracts.js';
export { hasValidBackgroundTaskHostMetadata, readBackgroundTaskOriginMetadata, };
export function createBackgroundTaskHostMetadata(origin) {
    return {
        backgroundTaskOrigin: {
            kind: origin.kind,
            taskIds: [...origin.taskIds],
            ...(origin.observedTerminalCount === undefined
                ? {}
                : { observedTerminalCount: origin.observedTerminalCount }),
        },
    };
}
//# sourceMappingURL=host-metadata.js.map