/**
 * The kernel reads every model through this source: each Turn and each
 * compaction asks `model` once for the credential of the model its
 * preparation returned, before any provider request is built.
 */
export function withModelCredentials(source, model) {
    return {
        prepare: async (input) => withModelCredential(await source.prepare(input), model),
        prepareCompaction: async (input) => withModelCredential(await source.prepareCompaction(input), model),
    };
}
async function withModelCredential(preparation, model) {
    const credential = await model.credential(preparation.llm);
    return { ...preparation, llm: { ...preparation.llm, ...credential } };
}
//# sourceMappingURL=model-credential.js.map