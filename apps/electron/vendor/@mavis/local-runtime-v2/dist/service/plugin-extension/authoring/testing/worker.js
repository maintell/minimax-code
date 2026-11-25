import { parentPort } from 'node:worker_threads';
import { hardenWorkerIntrinsics } from '../../host/realm/host-intrinsics.js';
import { describeError } from '../../host/realm/realm.js';
import { runTestFile } from './file-run.js';
/** Thin Worker shell for one `extension test` file; behaviour lives in file-run.ts. */
if (!parentPort)
    throw new Error('The extension test Worker requires a parent port.');
// The test file's realm and the module under test's realms run here, as in the render Worker.
hardenWorkerIntrinsics();
const port = parentPort;
const post = (message) => port.postMessage(message);
const running = new WeakSet();
// A test's detached promise is reported, not fatal.
process.on('unhandledRejection', (reason) => {
    post({ t: 'log', line: `[error] ${describeError(reason)}` });
});
async function run(job) {
    try {
        await runTestFile(job, post);
    }
    catch (error) {
        post({ t: 'load-failed', error: describeError(error) });
    }
}
port.on('message', (message) => {
    if (message.t === 'ping')
        post({ t: 'pong', n: message.n });
    else
        running.add(run(message.job));
});
//# sourceMappingURL=worker.js.map