export function formatBrowserErrorTriple(triple) {
    return `${triple.code}: ${triple.reason} Next: ${triple.next}`;
}
export function browserErrorTripleResult(triple) {
    return { success: false, code: triple.code, error: triple.reason, recovery: triple.next };
}
//# sourceMappingURL=browser-errors.js.map