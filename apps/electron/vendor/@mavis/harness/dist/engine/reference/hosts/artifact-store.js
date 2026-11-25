const ROOT = '/in-memory-artifacts';
/**
 * Artifacts held in memory, one directory per Session. A reference is stable
 * for the same call and content, so a re-projected result keeps its path; new
 * content gets a new reference and never replaces an earlier artifact.
 */
export function createInMemoryArtifactStore() {
    const sessions = new Map();
    const texts = new Map();
    const images = new Map();
    const directories = (sessionId) => ({
        snapshots: `${ROOT}/${sessionId}/snapshots`,
        toolOutputs: `${ROOT}/${sessionId}/tool-outputs`,
    });
    const allocate = (sessionId, key, extension) => {
        const session = sessions.get(sessionId);
        if (!session)
            throw new Error(`Session not found: ${sessionId}`);
        const existing = session.references.get(key);
        if (existing)
            return existing;
        const reference = `${directories(sessionId).toolOutputs}/${String(session.references.size + 1)}.${extension}`;
        session.references.set(key, reference);
        return reference;
    };
    return {
        store: {
            write: async (input) => {
                const reference = allocate(input.sessionId, callKey('txt', input, input.text), 'txt');
                texts.set(reference, input.text);
                return {
                    reference,
                    metadata: { artifact_kind: 'tool_output', sensitive: input.sensitive },
                };
            },
            writeImage: async (input) => {
                const reference = allocate(input.sessionId, callKey('image', input, input.data), 'image');
                images.set(reference, input.data);
                return { reference };
            },
            resolveEarlierFiles: async (sessionId) => {
                if (!sessions.has(sessionId))
                    throw new Error(`Session not found: ${sessionId}`);
                return directories(sessionId);
            },
        },
        createSession: (sessionId) => {
            if (sessions.has(sessionId))
                throw new Error(`Session already exists: ${sessionId}`);
            sessions.set(sessionId, { references: new Map() });
        },
        readText: (reference) => stored(texts, reference),
        readImage: (reference) => stored(images, reference),
    };
}
function callKey(kind, input, content) {
    return JSON.stringify([kind, input.toolCallId, input.toolName, content]);
}
function stored(artifacts, reference) {
    const content = artifacts.get(reference);
    if (content === undefined)
        throw new Error(`No artifact at ${reference}`);
    return content;
}
//# sourceMappingURL=artifact-store.js.map