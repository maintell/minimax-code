// Host-created objects only: tool-provided text/details cannot opt out of the
// output budget by imitating the citation protocol. Never serialize this trust.
const markers = new WeakSet();
export function createSourceReferenceMarkerBlock(text) {
    const block = { type: 'text', text };
    markers.add(block);
    return block;
}
export function isSourceReferenceMarkerBlock(block) {
    return markers.has(block);
}
//# sourceMappingURL=source-reference-marker.js.map