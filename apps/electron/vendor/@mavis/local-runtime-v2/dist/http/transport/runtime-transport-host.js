/**
 * Runtime transport host for Desktop MessagePort and SSH App Server clients.
 *
 * Consumes client frames (`request` / `stream-credit` / `abort`), maps them onto the
 * platform-neutral `Request -> Response` surface of the local runtime
 * (`handleRequest`) and streams the `Response` back as
 * `response-start` / `stream-chunk` / `stream-done` / `stream-error`
 * frames with a per-request monotonically increasing `seq`.
 *
 * The host is transport-agnostic: the caller wires `post` to
 * `MessagePortMain.postMessage` and feeds incoming `message` payloads into
 * `handleFrame`, which keeps this module free of Electron imports and fully
 * unit-testable.
 *
 * Semantics mirror the app:// protocol handler so the transport swap is
 * behavior-preserving:
 * - Path gate: only `/mavis/`, `/minimax-desktop/api/` and the
 *   `/archon/api/v1/` alias (rewritten to `/mavis/api/`) are served; other
 *   paths get a 404 without touching the runtime.
 * - An `abort` frame aborts the per-request `AbortController` — per-stream
 *   cancel semantics; a session turn abort stays a business
 *   `POST .../abort` request. Abort is idempotent; frames for unknown ids
 *   are ignored.
 * - Handler AbortError -> `stream-error` code `aborted` (client renders a
 *   499); other handler failures -> `stream-error` without code (client
 *   renders a 502 `local_runtime_unavailable`).
 *
 * Backpressure: response body chunks are coalesced by time window / byte
 * budget into fewer, larger frames. v2 clients also advertise an initial
 * response window and replenish it as their ReadableStream drains, bounding
 * MessagePort/renderer queues without adding endpoint-specific policy here.
 */
import { isRuntimeTransportClientFrame, } from '@mavis/shared/runtime-transport';
import { isGlobalEventStreamUrl, resolveRuntimeTransportUrl, runtimeTransportStreamKey, } from './runtime-transport-routing.js';
import { errorMessage, serveRuntimeTransportRequest, } from './runtime-transport-request.js';
import { createRuntimeTransportStreamCoordinator, } from './runtime-transport-stream-coordinator.js';
export { createRuntimeTransportStreamCoordinator, } from './runtime-transport-stream-coordinator.js';
const DEFAULT_COALESCE_INTERVAL_MS = 12;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
export function createRuntimeTransportHost(options) {
    const { handleRequest, post } = options;
    const coalesceIntervalMs = options.coalesceIntervalMs ?? DEFAULT_COALESCE_INTERVAL_MS;
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const warn = options.onWarning ?? (() => { });
    const streamCoordinator = options.streamCoordinator ?? createRuntimeTransportStreamCoordinator();
    const streamScope = options.streamScope?.trim();
    // EventBus SSE is fan-out: replacement is only meaningful within this host.
    const eventStreamCoordinator = createRuntimeTransportStreamCoordinator();
    const inFlight = new Map();
    let closed = false;
    function postSafe(frame) {
        if (closed)
            return;
        try {
            post(frame);
        }
        catch (error) {
            warn(`runtime transport post failed: ${errorMessage(error)}`);
        }
    }
    function startRequest(frame, url) {
        const entry = {
            controller: new AbortController(),
            clientAborted: false,
            streamCredits: frame.streamWindow ?? null,
        };
        inFlight.set(frame.id, entry);
        const streamKey = runtimeTransportStreamKey(frame.method, url, frame.headers);
        if (streamKey) {
            const globalEvents = isGlobalEventStreamUrl(url);
            const coordinator = globalEvents ? eventStreamCoordinator : streamCoordinator;
            const claimKey = globalEvents || !streamScope ? streamKey : `${streamScope}\u0000${streamKey}`;
            entry.releaseStream = coordinator.claim(claimKey, () => entry.abortAsSuperseded?.());
        }
        entry.completion = serveRuntimeTransportRequest({
            frame,
            url,
            entry,
            handleRequest,
            post,
            isClosed: () => closed,
            isActive: () => inFlight.get(frame.id) === entry,
            onFinalize: () => {
                if (inFlight.get(frame.id) === entry)
                    inFlight.delete(frame.id);
            },
            warn,
            coalesceIntervalMs,
            maxFrameBytes,
        });
    }
    return {
        handleFrame(message) {
            if (closed)
                return;
            if (!isRuntimeTransportClientFrame(message))
                return;
            if (message.type === 'stream-credit') {
                inFlight.get(message.id)?.grantStreamCredits?.(message.credits);
                return;
            }
            if (message.type === 'abort') {
                const entry = inFlight.get(message.id);
                if (!entry || entry.clientAborted)
                    return;
                entry.clientAborted = true;
                entry.releaseStream?.();
                entry.releaseStream = undefined;
                entry.controller.abort();
                entry.cancelBody?.();
                entry.releaseBackpressure?.();
                return;
            }
            if (inFlight.has(message.id)) {
                warn(`runtime transport duplicate request id dropped: ${message.id}`);
                return;
            }
            const url = resolveRuntimeTransportUrl(message.url);
            if (!url) {
                postSafe({
                    type: 'response-start',
                    id: message.id,
                    seq: 0,
                    status: 404,
                    headers: { 'content-type': 'application/json' },
                });
                postSafe({ type: 'stream-done', id: message.id, seq: 1 });
                return;
            }
            startRequest(message, url);
        },
        close() {
            if (closed)
                return;
            closed = true;
            for (const entry of inFlight.values()) {
                entry.clientAborted = true;
                entry.releaseStream?.();
                entry.releaseStream = undefined;
                entry.controller.abort();
                entry.cancelBody?.();
                entry.releaseBackpressure?.();
            }
            inFlight.clear();
        },
        inFlightCount() {
            return inFlight.size;
        },
        blockingRequestCount() {
            return [...inFlight.values()].filter((entry) => !entry.deliveryOnly).length;
        },
    };
}
//# sourceMappingURL=runtime-transport-host.js.map