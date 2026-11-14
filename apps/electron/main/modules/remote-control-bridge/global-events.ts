const LOCAL_RUNTIME_ORIGIN = 'http://rc-bridge.local';
const REMOTE_CONTROL_EVENT_STREAM_SCOPE = 'remote-control';
const EVENT_STREAM_SCOPE_QUERY = '_mavis_stream_scope';
/**
 * Local-only events never sent upstream. Worktree creation progress carries
 * local paths and Git output at ~150ms per frame; no controller renders it, and
 * a `workspace.*` frame would make every controller re-pull the resource snapshot.
 */
const LOCAL_ONLY_EVENT_TYPES = new Set(['workspace.worktree.progress']);
/**
 * Electron host adapter for the public Global Events SSE contract.
 *
 * This is the only RC layer that knows the generated DesktopService frame
 * shape. It admits frames through the shared frontend catalog and exposes a
 * small host-neutral stream to `@mavis/remote-control-bridge`.
 */
export function createRemoteControlGlobalEventSource(invoke, loadTransport) {
    return async function* subscribeGlobalEvents(signal) {
        const { createDesktopServiceClient, decodeGlobalEventFrame } = await loadTransport();
        if (signal.aborted)
            return;
        const client = createDesktopServiceClient({
            baseUrl: LOCAL_RUNTIME_ORIGIN,
            fetch: (input, init) => {
                const request = new Request(input, init);
                const url = new URL(request.url);
                // Keep replacement single-flight inside the RC consumer while
                // preserving other logical subscribers if transport ownership is
                // consolidated again. Losing this stream drops session.start/status
                // edges before they can be uploaded to the remote client.
                url.searchParams.set(EVENT_STREAM_SCOPE_QUERY, REMOTE_CONTROL_EVENT_STREAM_SCOPE);
                return invoke(new Request(url, request));
            },
        });
        const stream = client.subscribeGlobalEvents({}, { signal });
        try {
            for await (const frame of stream.frames) {
                const decoded = decodeGlobalEventFrame(frame);
                if (decoded?.kind !== 'event')
                    continue;
                if (LOCAL_ONLY_EVENT_TYPES.has(decoded.event.type))
                    continue;
                yield {
                    type: decoded.event.type,
                    timestamp: decoded.event.timestamp,
                    payload: decoded.event.payload,
                };
            }
        }
        finally {
            stream.close();
            // Do not await here: the outer generator can be returned while the
            // generated frame iterator is suspended. close() still aborts the
            // request/body; `closed` is best-effort bookkeeping on this return path.
            void stream.closed.catch(() => { });
        }
    };
}
