import { parentPort, workerData } from 'node:worker_threads';
import { hardenWorkerIntrinsics } from './host-intrinsics.js';
import { describeError } from './realm.js';
import { RealmRuntime } from './runtime.js';
/** Thin Worker shell; behaviour lives in runtime.ts so it stays testable in-thread. */
if (!parentPort)
    throw new Error('The extension host Worker requires a parent port.');
// This thread runs nothing but extension realms; harden before the first realm loads.
hardenWorkerIntrinsics();
const port = parentPort;
const { attribution, generation } = workerData;
const runtime = new RealmRuntime({ postMessage: (message) => port.postMessage(message) }, new Int32Array(attribution), { generation });
// A plugin's detached promise must not take the shared Worker down.
process.on('unhandledRejection', (reason) => {
    port.postMessage({ t: 'console', realmKey: '', level: 'error', text: describeError(reason) });
});
port.on('message', (message) => runtime.handle(message));
//# sourceMappingURL=worker.js.map