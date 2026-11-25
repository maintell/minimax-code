import { expectRejects, expectSame, expectTrue, } from '../conformance-case.js';
const KINDS = new Set(['cloud-sandbox', 'local-machine', 'none']);
const NETWORKS = new Set(['unrestricted', 'policy', 'none']);
const BYTES = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0;
}
function hasFileSystem(subject) {
    return subject.compute.capabilities.fileSystem;
}
async function read(subject, path, range) {
    const fs = subject.compute.fs;
    if (!fs)
        throw new TypeError('A compute with a file system must provide fs.');
    return Array.from(await fs.readFile(path, range ? { range } : undefined));
}
const identity = {
    name: 'names its kind, identity and workspace layout',
    run: async ({ compute }) => {
        expectTrue(KINDS.has(compute.kind), `kind is a compute kind: ${compute.kind}`);
        expectTrue(nonEmpty(compute.id), 'id is a non-empty string');
        expectTrue(nonEmpty(compute.workspace.root), 'workspace.root is a non-empty string');
        expectTrue(nonEmpty(compute.workspace.stateDir), 'workspace.stateDir is a non-empty string');
    },
};
const members = {
    name: 'provides exactly the members its capabilities declare',
    run: async ({ compute }) => {
        const declared = compute.capabilities;
        expectSame({
            fileSystem: compute.fs !== undefined,
            shell: compute.process !== undefined,
            backgroundProcess: typeof compute.process?.spawnBackground === 'function',
            transfer: compute.transfer !== undefined,
        }, {
            fileSystem: declared.fileSystem,
            shell: declared.shell,
            backgroundProcess: declared.backgroundProcess,
            transfer: declared.transfer,
        }, 'members');
        expectTrue(NETWORKS.has(declared.network), `network is a policy: ${declared.network}`);
        expectTrue(compute.kind !== 'none' || !(declared.fileSystem || declared.shell || declared.transfer), 'a compute of kind none provides no file system, shell or transfer');
    },
};
const invocationEnd = {
    name: 'ends one invocation after another',
    run: async ({ compute }) => {
        await compute.onInvocationEnd();
        await compute.onInvocationEnd();
    },
};
const wholeFile = {
    name: 'reads a whole file back',
    appliesTo: hasFileSystem,
    run: async (subject) => {
        const path = await subject.seedFile('whole.bin', BYTES);
        expectSame(await read(subject, path), Array.from(BYTES), 'whole file');
    },
};
const byteRange = {
    name: 'reads a byte range, and from an offset to the end',
    appliesTo: hasFileSystem,
    run: async (subject) => {
        const path = await subject.seedFile('range.bin', BYTES);
        expectSame(await read(subject, path, { offset: 2, length: 3 }), [2, 3, 4], 'bounded range');
        expectSame(await read(subject, path, { offset: 7 }), [7, 8, 9], 'open range');
    },
};
const clampedRange = {
    name: 'stops a range at the end of the file',
    appliesTo: hasFileSystem,
    run: async (subject) => {
        const path = await subject.seedFile('clamp.bin', BYTES);
        expectSame(await read(subject, path, { offset: 8, length: 5 }), [8, 9], 'range past the end');
        expectSame(await read(subject, path, { offset: 20, length: 2 }), [], 'range after the end');
    },
};
const missingFile = {
    name: 'rejects reading a file it does not hold',
    appliesTo: hasFileSystem,
    run: async (subject) => {
        await expectRejects(() => read(subject, subject.missingPath), 'missing file');
    },
};
/** What harness core relies on: capability-consistent members and `fs.readFile`. */
export const computeEnvironmentConformanceCases = Object.freeze([
    identity,
    members,
    invocationEnd,
    wholeFile,
    byteRange,
    clampedRange,
    missingFile,
]);
//# sourceMappingURL=compute-conformance.js.map