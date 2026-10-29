/**
 * Resolves a complete Goal prompt bundle against one captured snapshot. A bad
 * remote bundle is retried once against the builtin snapshot, so one model
 * request never combines templates from two versions. The opaque scope is kept
 * for the internal Turn that will consume the rendered content.
 */
export async function readPromptBundleScopeWithBuiltinFallback(input, templates) {
    if (!input)
        return { templates: builtinPromptTemplates(templates) };
    const source = isPromptReadScope(input) ? input.source : input;
    const snapshot = isPromptReadScope(input) ? input.snapshot : await source.capture();
    const resolved = await readPromptBundle(source, snapshot, templates);
    if (resolved)
        return { templates: resolved, promptRead: { source, snapshot } };
    const builtinSnapshot = await source.captureBuiltin();
    const builtinResolved = await readPromptBundle(source, builtinSnapshot, templates);
    if (builtinResolved) {
        return { templates: builtinResolved, promptRead: { source, snapshot: builtinSnapshot } };
    }
    return { templates: builtinPromptTemplates(templates) };
}
function isPromptReadScope(input) {
    return 'source' in input && 'snapshot' in input;
}
function builtinPromptTemplates(templates) {
    return new Map(templates.map((template) => [template.key, template.builtin]));
}
async function readPromptBundle(source, snapshot, templates) {
    const reads = await Promise.all(templates.map((template) => source.read(snapshot, template.key)));
    if (reads.some((result) => result.kind === 'invalid'))
        return undefined;
    return new Map(templates.map((template, index) => [
        template.key,
        reads[index] ? resolvePromptTemplate(reads[index], template.builtin) : template.builtin,
    ]));
}
function resolvePromptTemplate(result, builtin) {
    return result.kind === 'found' ? result.content : builtin;
}
//# sourceMappingURL=prompt-bundle.js.map