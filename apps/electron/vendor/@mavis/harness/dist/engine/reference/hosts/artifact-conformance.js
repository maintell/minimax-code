import { expectRejects, expectSame, expectTrue, } from '../conformance-case.js';
const UNKNOWN_SESSION = 'conformance-unknown-session';
const OUTPUT = 'first line of a long tool output\nsecond line\n';
const PNG_SIGNATURE = 'iVBORw0KGgo=';
function textInput(sessionId, text = OUTPUT, toolCallId = 'call-1') {
    return {
        sessionId,
        toolCallId,
        turnId: 'turn-1',
        toolName: 'bash',
        text,
        originalBytes: new TextEncoder().encode(text).length,
        sensitive: false,
    };
}
function imageInput(sessionId) {
    return {
        sessionId,
        toolCallId: 'call-image',
        toolName: 'screenshot',
        data: PNG_SIGNATURE,
        mimeType: 'image/png',
    };
}
async function writeText(subject, input) {
    const { reference } = await subject.store.write(input);
    expectTrue(reference.length > 0, 'a written artifact has a reference');
    return reference;
}
const readsBack = {
    name: 'reads a tool output back from its reference',
    run: async (subject) => {
        const sessionId = await subject.createSession();
        const reference = await writeText(subject, textInput(sessionId));
        expectSame(await subject.readText(reference), OUTPUT, 'artifact text');
    },
};
const stableReference = {
    name: 'keeps one reference for the same result',
    run: async (subject) => {
        const sessionId = await subject.createSession();
        const first = await writeText(subject, textInput(sessionId));
        const second = await writeText(subject, textInput(sessionId));
        expectSame(second, first, 'reference of a rewritten result');
    },
};
const keepsEarlier = {
    name: 'keeps an earlier artifact when the content changes',
    run: async (subject) => {
        const sessionId = await subject.createSession();
        const first = await writeText(subject, textInput(sessionId));
        const changed = `${OUTPUT}third line\n`;
        const second = await writeText(subject, textInput(sessionId, changed));
        expectTrue(first !== second, 'new content gets a new reference');
        expectSame(await subject.readText(first), OUTPUT, 'earlier artifact text');
        expectSame(await subject.readText(second), changed, 'later artifact text');
    },
};
const separatesSessions = {
    name: 'keeps each Session in its own directories',
    run: async (subject) => {
        const first = await subject.createSession();
        const second = await subject.createSession();
        const firstReference = await writeText(subject, textInput(first));
        const secondReference = await writeText(subject, textInput(second));
        expectTrue(firstReference !== secondReference, 'Sessions get distinct references');
        const [firstFiles, secondFiles] = await Promise.all([
            subject.store.resolveEarlierFiles(first),
            subject.store.resolveEarlierFiles(second),
        ]);
        expectTrue(firstFiles.toolOutputs !== secondFiles.toolOutputs, 'distinct tool-output dirs');
        if (firstFiles.snapshots !== undefined) {
            expectTrue(firstFiles.snapshots !== secondFiles.snapshots, 'distinct snapshot dirs');
        }
    },
};
const images = {
    name: 'stores an image and keeps its reference',
    run: async (subject) => {
        const sessionId = await subject.createSession();
        const first = await subject.store.writeImage(imageInput(sessionId));
        const second = await subject.store.writeImage(imageInput(sessionId));
        expectTrue(first.reference.length > 0, 'an image artifact has a reference');
        expectSame(second.reference, first.reference, 'reference of a rewritten image');
        expectSame(await subject.readImage(first.reference), PNG_SIGNATURE, 'image data');
    },
};
const earlierFiles = {
    name: 'names the directories a compaction summary points back to',
    run: async (subject) => {
        const sessionId = await subject.createSession();
        const text = await writeText(subject, textInput(sessionId));
        const image = await subject.store.writeImage(imageInput(sessionId));
        const { snapshots, toolOutputs } = await subject.store.resolveEarlierFiles(sessionId);
        expectTrue(toolOutputs.length > 0, 'the tool-output directory is non-empty');
        if (snapshots !== undefined) {
            expectTrue(snapshots.length > 0, 'the snapshot directory is non-empty');
            expectTrue(snapshots !== toolOutputs, 'snapshots and tool outputs are separate');
        }
        expectTrue(text.startsWith(toolOutputs), 'a tool output lives under toolOutputs');
        expectTrue(image.reference.startsWith(toolOutputs), 'an image lives under toolOutputs');
    },
};
const unknownSession = {
    name: 'refuses a Session it does not hold',
    run: async (subject) => {
        await expectRejects(async () => subject.store.write(textInput(UNKNOWN_SESSION)), 'write');
        await expectRejects(async () => subject.store.writeImage(imageInput(UNKNOWN_SESSION)), 'writeImage');
        await expectRejects(() => subject.store.resolveEarlierFiles(UNKNOWN_SESSION), 'resolveEarlierFiles');
    },
};
/** Session-owned artifact storage as tool-result archiving and compaction use it. */
export const artifactStoreConformanceCases = Object.freeze([
    readsBack,
    stableReference,
    keepsEarlier,
    separatesSessions,
    images,
    earlierFiles,
    unknownSession,
]);
//# sourceMappingURL=artifact-conformance.js.map