import { ComputerUseError } from "@mavis/computer-use";
import { startCuaUtilityServer } from "./cua-utility-server";
import { createCuaStructuredLogger } from "./cua-logging";
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
            onOperation: ({ sessionId, turnId, requestId }, target) => parentPort.postMessage({
                type: 'cua-operation',
                generation,
                sessionId,
                turnId,
                requestId,
                ...(target ? { overlayTarget: target } : {}),
            }),
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
            .catch((error) => {
            // Invalid profile/host setup fails before the server can signal readiness. The parent
            // records stderr as utility_output, so leave the bounded reason before exiting.
            createCuaStructuredLogger(undefined, { generation }).error('utility_exit', {
                outcome: 'startup_failed',
                errorCode: startupErrorCode(error),
            });
            // Pipe writes are asynchronous on macOS; exit after the record above is flushed.
            process.stderr.write('', () => process.exit(1));
        });
    });
}
/** Error codes and names only; arbitrary messages may contain private profile paths. */
function startupErrorCode(error) {
    if (error instanceof ComputerUseError)
        return error.code;
    const code = error?.code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code))
        return code;
    return error instanceof Error ? error.name : 'unknown';
}
