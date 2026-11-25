import { MessageChannel } from 'node:worker_threads';
import { RealmRuntime } from '../../host/realm/runtime.js';
/**
 * Runs the real Worker-side runtime in this thread over a MessageChannel, so messages are still
 * structured-cloned. Used inside the `extension test` Worker; production renders use a real Worker.
 */
export function inThreadWorkerFactory(options, activity = { inFlight: 0 }) {
    return (init) => {
        const { port1, port2 } = new MessageChannel();
        const runtime = new RealmRuntime({
            postMessage: (message) => {
                activity.inFlight += 1;
                port2.postMessage(message);
            },
        }, new Int32Array(init.attribution), { ...options, generation: init.generation });
        port2.on('message', (message) => {
            activity.inFlight -= 1;
            runtime.handle(message);
        });
        port1.on('message', () => {
            activity.inFlight -= 1;
        });
        const exits = [];
        let alive = true;
        const exit = (code) => {
            if (!alive)
                return;
            alive = false;
            activity.inFlight = 0;
            port1.close();
            port2.close();
            for (const listener of exits)
                listener(code);
        };
        const handle = {
            postMessage: (message) => {
                if (!alive)
                    return;
                activity.inFlight += 1;
                port1.postMessage(message);
            },
            on: ((event, listener) => {
                if (event === 'message')
                    port1.on('message', listener);
                if (event === 'exit')
                    exits.push(listener);
                return handle;
            }),
            terminate: async () => {
                exit(1);
                return 1;
            },
        };
        return handle;
    };
}
//# sourceMappingURL=in-thread-worker.js.map