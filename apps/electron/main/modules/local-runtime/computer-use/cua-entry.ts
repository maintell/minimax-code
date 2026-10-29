import { startCuaUtilityServer } from "./cua-utility-server";
const parentPort = process.parentPort;
if (parentPort) {
    let releaseLease;
    parentPort.on('message', (event) => {
        const data = event.data;
        if (data.type === 'cua-release') {
            releaseLease?.(typeof data.sessionId === 'string'
                ? data.sessionId
                : undefined);
            return;
        }
        if (data.type !== 'cua-connect' || !event.ports?.[0])
            return;
        const port = event.ports[0];
        const generation = typeof data.generation === 'number' ? data.generation : 0;
        void startCuaUtilityServer({
            parentPort: port,
            generation,
            dataDir: process.env.MINIMAX_DATA_DIR ?? '',
            exit: (code) => process.exit(code),
            onReady: () => parentPort.postMessage({ type: 'cua-ready', generation }),
            onPreviewTarget: (target) => parentPort.postMessage({ type: 'cua-preview-target', generation, target }),
            onOperation: ({ sessionId, turnId, requestId }) => parentPort.postMessage({ type: 'cua-operation', generation, sessionId, turnId, requestId }),
            onOperationFinished: ({ sessionId, turnId, requestId }) => parentPort.postMessage({
                type: 'cua-operation-finished',
                generation,
                sessionId,
                turnId,
                requestId,
            }),
            onRelease: (sessionId, turnId) => parentPort.postMessage({ type: 'cua-released', generation, sessionId, turnId }),
            onActivityChange: (activeRequestCount) => parentPort.postMessage({
                type: 'cua-activity',
                version: 1,
                generation,
                activeRequestCount,
            }),
        })
            .then((server) => {
            releaseLease = server.releaseLease;
        })
            .catch(() => {
            // Invalid profile/host setup fails before the server can signal readiness.
            process.exit(1);
        });
    });
}
