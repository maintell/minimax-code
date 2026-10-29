export function toHeaderMap(headers) {
    const map = {};
    headers.forEach((value, key) => {
        map[key] = value;
    });
    return map;
}
export function isEventStreamResponse(response) {
    return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
}
export function concatChunks(chunks, totalBytes) {
    const [first] = chunks;
    if (first && chunks.length === 1)
        return first;
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}
//# sourceMappingURL=runtime-transport-response.js.map