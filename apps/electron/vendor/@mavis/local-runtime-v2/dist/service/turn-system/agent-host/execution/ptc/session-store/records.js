import { STORED_DESC_CHARS } from './contracts.js';
/** The last record of every key: what `load` and the reminder see. */
export function liveRecords(records) {
    const live = new Map();
    for (const record of records)
        live.set(record.key, record);
    return live;
}
/** Keeps a description short enough that it cannot grow the store file. */
function boundedDesc(desc) {
    if (desc === undefined || desc.length <= STORED_DESC_CHARS)
        return desc;
    return Array.from(desc).slice(0, STORED_DESC_CHARS).join('');
}
export function encodeRecord(write, context) {
    const { seq, turnId, ts, descs } = context;
    const desc = boundedDesc(write.desc ?? descs.get(write.key));
    descs.set(write.key, desc);
    const prefix = `{"seq":${seq},"turn_id":${JSON.stringify(turnId)},"key":${JSON.stringify(write.key)}` +
        `,"desc":${desc === undefined ? 'null' : JSON.stringify(desc)},"ts":${ts},"value":`;
    const encoder = new TextEncoder();
    const head = encoder.encode(prefix);
    const value = encoder.encode(write.valueJson);
    const tail = encoder.encode('}\n');
    const chunk = new Uint8Array(head.byteLength + value.byteLength + tail.byteLength);
    chunk.set(head, 0);
    chunk.set(value, head.byteLength);
    chunk.set(tail, head.byteLength + value.byteLength);
    return {
        chunk,
        record: {
            seq,
            turnId,
            key: write.key,
            type: valueType(write.valueJson),
            bytes: value.byteLength,
            ...(desc === undefined ? {} : { desc }),
            offset: 0,
        },
    };
}
/** Where a record's value starts inside the appended chunk (after its header). */
export function valueOffset(encoded, index) {
    let offset = 0;
    for (let position = 0; position < index; position += 1) {
        offset += encoded[position].chunk.byteLength;
    }
    const entry = encoded[index];
    return offset + (entry.chunk.byteLength - entry.record.bytes - 2);
}
export function concatChunks(chunks) {
    const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}
/** JSON type from the encoded value's first byte; no parse needed. */
function valueType(valueJson) {
    switch (valueJson[0]) {
        case '[':
            return 'Array';
        case '{':
            return 'Object';
        case '"':
            return 'String';
        case 't':
        case 'f':
            return 'Boolean';
        case 'n':
            return 'null';
        default:
            return 'Number';
    }
}
//# sourceMappingURL=records.js.map