/** Attach a domain-owned request parsing policy without teaching the shared adapter the domain. */
export function withRequestParseErrorMapper(binding, mapRequestParseError) {
    return { ...binding, mapRequestParseError };
}
/** Type-check happens at this call site; the returned binding is type-erased. */
export function defineRoute(contract, handler) {
    return {
        kind: 'json',
        name: contract.name,
        meta: contract.meta,
        handler: handler,
    };
}
export function defineSseRoute(contract, handler) {
    return {
        kind: 'sse',
        name: contract.name,
        meta: contract.meta,
        handler: handler,
    };
}
//# sourceMappingURL=define-route.js.map