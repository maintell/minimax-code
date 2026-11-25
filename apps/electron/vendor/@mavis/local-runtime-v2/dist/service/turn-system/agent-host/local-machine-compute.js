import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
/**
 * Only `fs` is provided. Desktop tools run commands, transfers and the GUI
 * through their own Host tools, so the members that describe `process` and
 * `transfer` stay false; network and GUI describe the machine itself.
 */
const LOCAL_MACHINE_CAPABILITIES = {
    fileSystem: true,
    shell: false,
    backgroundProcess: false,
    streamingOutput: false,
    transfer: false,
    network: 'unrestricted',
    gui: true,
    separatesOutputStreams: false,
};
/**
 * The desktop machine as the compute of every run. The Agent works on the
 * host file system under the permission gate, so the layout root is the file
 * system root; each Turn's project folder stays the Session working directory.
 * Creating it touches nothing on disk.
 */
export function createLocalMachineCompute(options) {
    return {
        kind: 'local-machine',
        id: 'local',
        capabilities: LOCAL_MACHINE_CAPABILITIES,
        workspace: {
            root: options.root ?? path.resolve('/'),
            get stateDir() {
                return options.dataDir();
            },
        },
        fs: localMachineFileSystem(),
        onInvocationEnd: () => Promise.resolve(),
    };
}
/**
 * Only `readFile` is implemented: it is the one method harness core calls.
 * Unlike a cloud read it has no single-read cap, which keeps desktop inline
 * attachments unchanged.
 */
function localMachineFileSystem() {
    return {
        readFile: async (file, opts) => (opts?.range ? readRange(file, opts.range) : readFile(file)),
        stat: unused('stat'),
        writeFile: unused('writeFile'),
        readdir: unused('readdir'),
        mkdir: unused('mkdir'),
        rename: unused('rename'),
        realpath: unused('realpath'),
        remove: unused('remove'),
        digest: unused('digest'),
    };
}
/** A file system method harness core does not call on the desktop. */
function unused(method) {
    return () => Promise.reject(new Error(`local-machine compute does not implement fs.${method} on the desktop`));
}
async function readRange(file, range) {
    const handle = await open(file, 'r');
    try {
        const { size } = await handle.stat();
        const end = range.length === undefined ? size : Math.min(size, range.offset + range.length);
        const length = Math.max(0, end - range.offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, range.offset);
        return buffer.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=local-machine-compute.js.map