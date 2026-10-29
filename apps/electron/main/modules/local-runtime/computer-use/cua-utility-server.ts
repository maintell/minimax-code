import { randomUUID } from "node:crypto";
import { createComputerUseClient, ComputerUseError } from "@mavis/computer-use";
import { prepareDesktopComputerUseComponent } from "./packaged-component";
import { createPreviewTargetPublisher } from "./cua-preview-target";
import { createCuaDisplayReader } from "./cua-displays";
import { createCuaStructuredLogger } from "./cua-logging";
// Existing callers and mapping tests use this entry; execution is shared with TUI.
export { mapRequestToCuaTool, validateClickAction, shouldAvoidNativeBackgroundClick, foregroundShortcutRefusal } from "@mavis/computer-use/mapping";

/** Desktop presentation/MessagePort adapter. Native ownership belongs to the shared client. */
export async function startCuaUtilityServer(input) {
    const logger = input.logger ?? createCuaStructuredLogger(undefined, { generation: input.generation });
    let preview;
    let previewOwner;
    let requestPort;
    let stopped = false;
    const active = new Map();
    input.parentPort.start?.();
    const client = createComputerUseClient({
        dataDir: input.dataDir,
        ...(await prepareDesktopComputerUseComponent(input.dataDir)),
        ownerId: `desktop:${process.pid}:${randomUUID()}`,
        sdkRuntimeDirectory: __dirname,
        logger,
        readDisplays: createCuaDisplayReader(input.parentPort, input.generation),
        onActivityChange: input.onActivityChange,
        onOperation: input.onOperation,
        onOperationFinished: input.onOperationFinished,
        onRelease(sessionId, turnId) {
            if ((!sessionId || previewOwner?.sessionId === sessionId) &&
                (!turnId || previewOwner?.turnId === turnId)) {
                preview = undefined;
                previewOwner = undefined;
            }
            input.onRelease?.(sessionId, turnId);
        },
        async onMapped({ runtime, request, payload, signal }) {
            if (stopped || signal.aborted || !input.onPreviewTarget || process.platform !== 'darwin')
                return;
            if (!preview ||
                previewOwner?.generation !== runtime.generation ||
                previewOwner.sessionId !== request.sessionId ||
                previewOwner.turnId !== request.turnId) {
                const publish = createPreviewTargetPublisher(runtime, (target) => {
                    // Metadata from a released/replaced runtime must not resurrect an old preview.
                    if (!stopped && preview === publish)
                        input.onPreviewTarget?.(target);
                });
                preview = publish;
                previewOwner = {
                    sessionId: request.sessionId,
                    turnId: request.turnId,
                    generation: runtime.generation,
                };
            }
            await preview(request, payload);
        },
    });
    const releaseLease = (sessionId, turnId) => {
        for (const item of active.values()) {
            if ((!sessionId || item.request.sessionId === sessionId) &&
                (!turnId || item.request.turnId === turnId))
                item.controller.abort();
        }
        client.release(sessionId, turnId);
    };
    const shutdown = () => {
        if (stopped)
            return;
        stopped = true;
        releaseLease();
        void client.close().then(() => input.exit?.(0), () => {
            logger.error('utility_exit', { outcome: 'drain_unconfirmed' });
            input.exit?.(1);
        });
    };
    input.parentPort.on('close', shutdown);
    const handle = (port, data) => {
        if (stopped || port !== requestPort || !data || typeof data !== 'object')
            return;
        const message = data;
        if (message.type === 'cua-release' && message.generation === input.generation) {
            releaseLease(message.sessionId, message.turnId);
            return;
        }
        if (message.type === 'cua-cancel' &&
            message.generation === input.generation &&
            typeof message.requestId === 'string') {
            active.get(message.requestId)?.controller.abort();
            return;
        }
        if (message.version !== 1 ||
            typeof message.requestId !== 'string' ||
            typeof message.kind !== 'string' ||
            typeof message.sessionId !== 'string')
            return;
        const request = message;
        const respond = (body) => {
            try {
                port.postMessage({
                    version: 1,
                    requestId: request.requestId,
                    generation: request.generation,
                    ...body,
                });
            }
            catch {
                /* The closed caller cannot receive a late result; never replay. */
            }
        };
        if (request.generation !== input.generation || active.has(request.requestId)) {
            respond({
                ok: false,
                error: {
                    code: 'computer_generation_mismatch',
                    message: 'Stale or duplicate computer request.',
                    completion: 'not_started',
                },
            });
            return;
        }
        const controller = new AbortController();
        active.set(request.requestId, { request, controller });
        void client
            .call(request, controller.signal)
            .then((result) => respond({ ok: true, result }), (error) => {
            const code = error instanceof ComputerUseError ? error.code : 'computer_driver_error';
            if (code === 'computer_permission_required' ||
                code === 'computer_capture_verification_required')
                input.parentPort.postMessage({
                    type: 'cua-permission-required',
                    generation: input.generation,
                });
            respond({
                ok: false,
                error: {
                    code,
                    message: error instanceof Error ? error.message : 'Computer Use failed.',
                    completion: error instanceof ComputerUseError ? error.completion : 'unknown',
                },
            });
        })
            .finally(() => {
            active.delete(request.requestId);
        });
    };
    input.parentPort.on('message', ({ data, ports }) => {
        if (!data || typeof data !== 'object')
            return;
        const message = data;
        if (message.type === 'cua-shutdown') {
            shutdown();
            return;
        }
        if (message.type === 'cua-release') {
            releaseLease(message.sessionId, message.turnId);
            return;
        }
        if (stopped || message.type !== 'cua-runtime-connect' || !ports?.[0])
            return;
        const old = requestPort;
        requestPort = undefined;
        if (old) {
            releaseLease();
            old.close?.();
        }
        const port = ports[0];
        requestPort = port;
        port.on('message', (event) => handle(port, event.data));
        port.on('close', () => {
            if (requestPort === port) {
                requestPort = undefined;
                releaseLease();
            }
        });
        port.start?.();
        input.parentPort.postMessage({ type: 'cua-runtime-ready', generation: input.generation });
    });
    try {
        await client.ensureReady();
        input.parentPort.postMessage({ type: 'cua-ready', version: 1, generation: input.generation });
        input.onReady?.();
    }
    catch (error) {
        logger.error('utility_exit', {
            outcome: 'startup_failed',
            errorCode: error instanceof ComputerUseError ? error.code : 'computer_driver_error',
        });
        await client.close().catch(() => undefined);
        input.exit?.(1);
    }
    return { releaseLease };
}
