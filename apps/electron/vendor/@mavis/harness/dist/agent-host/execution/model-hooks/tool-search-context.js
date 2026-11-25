export function toolSearchContextHooks(hook) {
    const inPhase = (phase) => (input) => input.phase === phase ? hook(input) : undefined;
    return { iteration: inPhase('iteration'), initial: inPhase('initial') };
}
//# sourceMappingURL=tool-search-context.js.map