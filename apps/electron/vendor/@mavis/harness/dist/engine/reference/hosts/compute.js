/**
 * A compute whose file system is a map of paths to bytes. It provides the
 * reads harness core performs (`fs.readFile`, whole or by range); commands,
 * transfers and file writes stay unavailable, so `shell` and `transfer` are
 * false and the other file system methods reject.
 */
export function createInMemoryCompute(options = {}) {
    const files = new Map();
    const fileSystem = options.fileSystem ?? true;
    const root = options.root ?? '/workspace';
    return {
        compute: {
            kind: fileSystem ? 'local-machine' : 'none',
            id: 'in-memory',
            capabilities: capabilities(fileSystem),
            workspace: { root, stateDir: `${root}/.mavis` },
            ...(fileSystem ? { fs: inMemoryFileSystem(files) } : {}),
            onInvocationEnd: async () => undefined,
        },
        seed: (path, data) => {
            files.set(path, Uint8Array.from(data));
        },
    };
}
function capabilities(fileSystem) {
    return {
        fileSystem,
        shell: false,
        backgroundProcess: false,
        streamingOutput: false,
        transfer: false,
        network: 'none',
        gui: false,
        separatesOutputStreams: false,
    };
}
function inMemoryFileSystem(files) {
    return {
        readFile: async (path, opts) => {
            const data = files.get(path);
            if (!data)
                throw new Error(`No such file: ${path}`);
            return opts?.range ? sliceRange(data, opts.range) : Uint8Array.from(data);
        },
        stat: unprovided('stat'),
        writeFile: unprovided('writeFile'),
        readdir: unprovided('readdir'),
        mkdir: unprovided('mkdir'),
        rename: unprovided('rename'),
        realpath: unprovided('realpath'),
        remove: unprovided('remove'),
        digest: unprovided('digest'),
    };
}
function sliceRange(data, range) {
    const end = range.length === undefined ? data.length : range.offset + range.length;
    return data.slice(range.offset, end);
}
function unprovided(method) {
    return async () => {
        throw new Error(`The in-memory compute does not provide fs.${method}`);
    };
}
//# sourceMappingURL=compute.js.map