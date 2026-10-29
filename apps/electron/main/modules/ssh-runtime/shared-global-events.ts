import { createHash } from "node:crypto";
import { isRuntimeTransportClientFrame, RUNTIME_TRANSPORT_MAX_STREAM_WINDOW } from "@mavis/shared/runtime-transport";
const EVENTS_PATH = '/minimax-desktop/api/v1/events';
const MAX_PENDING_EVENTS = 256;
function loadThriftClient() {
    if (process.env.VITEST === 'true')
        return import('@mavis/thrift-gen-client');
    // eslint-disable-next-line no-new-func -- Preserve native ESM import in Electron's compiled CJS host.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    return dynamicImport('@mavis/thrift-gen-client');
}
/** One upstream per host manager and request identity; each renderer keeps its own credits/lifetime. */
export class SharedSshGlobalEvents {
    constructor(fetch, post) {
        this.fetch = fetch;
        this.post = post;
        this.groups = new Map();
        this.subscribers = new Map();
    }
    handle(value) {
        if (!isRuntimeTransportClientFrame(value))
            return false;
        if (value.type === 'request') {
            let url;
            try {
                url = new URL(value.url, 'http://ssh-runtime.local');
            }
            catch {
                return false;
            }
            // Only the unfiltered generated contract is shared. Other scopes keep their own request.
            if (value.method !== 'GET' ||
                url.pathname !== EVENTS_PATH ||
                url.search ||
                value.body != null)
                return false;
            if (!this.subscribers.has(value.id))
                this.subscribe(value);
            return true;
        }
        const subscriber = this.subscribers.get(value.id);
        if (!subscriber)
            return false;
        if (value.type === 'abort') {
            this.remove(subscriber);
            this.post({ type: 'stream-done', id: subscriber.id, seq: ++subscriber.seq });
        }
        else if (subscriber.credits !== null) {
            subscriber.credits = Math.min(RUNTIME_TRANSPORT_MAX_STREAM_WINDOW, subscriber.credits + value.credits);
            this.flush(subscriber);
        }
        return true;
    }
    release(id) {
        const subscriber = this.subscribers.get(id);
        if (!subscriber)
            return false;
        this.remove(subscriber);
        return true;
    }
    close() {
        for (const subscriber of [...this.subscribers.values()])
            this.remove(subscriber);
    }
    subscribe(request) {
        // Trace metadata identifies a request, not the shared subscription. Keep
        // authorization and caller scopes in the identity, and forward all headers.
        const headers = {};
        new Headers(request.headers).forEach((value, name) => {
            headers[name] = value;
        });
        const key = JSON.stringify(Object.entries(headers)
            .filter(([name]) => name !== 'x-trace-id')
            .sort(([a], [b]) => a.localeCompare(b)));
        let group = this.groups.get(key);
        if (!group) {
            group = {
                key,
                stream: null,
                subscribers: new Set(),
                admitted: false,
            };
            this.groups.set(key, group);
            void this.consume(group, headers);
        }
        const subscriber = {
            id: request.id,
            seq: 0,
            started: false,
            credits: request.streamWindow ?? null,
            pending: [],
            group,
        };
        group.subscribers.add(subscriber);
        this.subscribers.set(request.id, subscriber);
        // A late subscriber needs an admission frame, not a replay of another window's events.
        if (group.admitted)
            this.enqueue(subscriber, { kind: 'heartbeat', timestamp: Date.now() });
    }
    async consume(group, headers) {
        let clientModule;
        try {
            clientModule = await loadThriftClient();
            // The last consumer may leave while the ESM module is loading.
            if (this.groups.get(group.key) !== group)
                return;
            // Distinct authorized groups must also be distinct to the remote host's
            // single-flight coordinator. Hash the identity so headers never enter the
            // URL; the same group reuses its scope after reconnect. The query form is
            // supported by GlobalEvents hosts predating the stream-scope header.
            const scope = `ssh-events-${createHash('sha256').update(group.key).digest('hex').slice(0, 48)}`;
            const client = clientModule.createDesktopServiceClient({
                baseUrl: 'http://ssh-runtime.local',
                headers,
                fetch: (input, init) => {
                    const request = new Request(input, init);
                    const url = new URL(request.url);
                    url.searchParams.set('_mavis_stream_scope', scope);
                    return this.fetch(new Request(url, request));
                },
            });
            group.stream = client.subscribeGlobalEvents({});
            for await (const frame of group.stream.frames) {
                if (this.groups.get(group.key) !== group)
                    return;
                group.admitted = true;
                for (const subscriber of [...group.subscribers])
                    this.enqueue(subscriber, frame);
            }
            if (this.groups.get(group.key) === group)
                this.fail(group);
        }
        catch (error) {
            if (this.groups.get(group.key) === group)
                this.fail(group, clientModule && error instanceof clientModule.HttpStatusError ? error.status : undefined);
        }
        finally {
            group.stream?.close();
            void group.stream?.closed.catch(() => { });
        }
    }
    enqueue(subscriber, frame) {
        if (!subscriber.started) {
            subscriber.started = true;
            this.post({
                type: 'response-start',
                id: subscriber.id,
                seq: 0,
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            });
        }
        if (subscriber.pending.length >= MAX_PENDING_EVENTS) {
            this.remove(subscriber);
            this.post({
                type: 'stream-error',
                id: subscriber.id,
                seq: ++subscriber.seq,
                code: 'ssh_event_consumer_overflow',
                message: 'SSH event consumer fell behind; reconnect required.',
            });
            return;
        }
        subscriber.pending.push(`data: ${JSON.stringify(frame)}\n\n`);
        this.flush(subscriber);
    }
    flush(subscriber) {
        while (subscriber.pending.length && subscriber.credits !== 0) {
            if (subscriber.credits !== null)
                subscriber.credits -= 1;
            const payload = subscriber.pending.shift();
            if (payload === undefined)
                break;
            this.post({
                type: 'stream-chunk',
                id: subscriber.id,
                seq: ++subscriber.seq,
                payload,
            });
        }
    }
    fail(group, status) {
        for (const subscriber of [...group.subscribers]) {
            this.remove(subscriber);
            if (!subscriber.started && status !== undefined) {
                // Preserve permanent HTTP failures so the renderer does not retry authentication forever.
                this.post({
                    type: 'response-start',
                    id: subscriber.id,
                    seq: 0,
                    status,
                    headers: { 'content-type': 'application/json' },
                });
                this.post({ type: 'stream-done', id: subscriber.id, seq: 1 });
            }
            else {
                this.post({
                    type: 'stream-error',
                    id: subscriber.id,
                    seq: ++subscriber.seq,
                    code: 'runtime_connection_lost',
                    message: 'SSH event stream closed; reconnect required.',
                });
            }
        }
    }
    remove(subscriber) {
        this.subscribers.delete(subscriber.id);
        subscriber.pending.length = 0;
        const group = subscriber.group;
        group.subscribers.delete(subscriber);
        if (group.subscribers.size === 0) {
            this.groups.delete(group.key);
            group.stream?.close();
            void group.stream?.closed.catch(() => { });
        }
    }
}

