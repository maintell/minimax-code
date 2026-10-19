/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/
 */
import { UniffiInternalError } from "./errors.js";
export class RustBuffer {
    readOffset = 0;
    writeOffset = 0;
    capacity;
    arrayBuffer;
    constructor(arrayBuffer) {
        this.arrayBuffer = arrayBuffer;
        this.capacity = arrayBuffer.byteLength;
    }
    /**
     * Allocate a JS-owned buffer of the given capacity. Used by tests; not by
     * the runtime path, which calls `RustBuffer.fromUint8Array(allocator(n))`
     * with a runtime-supplied allocator.
     */
    static withCapacity(capacity) {
        const buf = new ArrayBuffer(capacity);
        return new RustBuffer(buf);
    }
    static empty() {
        return this.withCapacity(0);
    }
    static fromArrayBuffer(buf) {
        return new RustBuffer(buf);
    }
    /**
     * Construct a `RustBuffer` over a `Uint8Array` view. Cursors track absolute
     * offsets into the backing `ArrayBuffer`, so `byteOffset` and `byteLength`
     * delimit the readable/writable region.
     */
    static fromUint8Array(view) {
        const buf = new RustBuffer(view.buffer);
        buf.readOffset = view.byteOffset;
        buf.writeOffset = view.byteOffset;
        buf.capacity = view.byteOffset + view.byteLength;
        return buf;
    }
    get length() {
        return this.arrayBuffer.byteLength;
    }
    get byteArray() {
        return new Uint8Array(this.arrayBuffer);
    }
    readArrayBuffer(numBytes) {
        const start = this.readOffset;
        const end = this.checkOverflow(start, numBytes);
        const value = this.arrayBuffer.slice(start, end);
        this.readOffset = end;
        return value;
    }
    readByteArray(numBytes) {
        const start = this.readOffset;
        const end = this.checkOverflow(start, numBytes);
        const value = new Uint8Array(this.arrayBuffer, start, numBytes);
        this.readOffset = end;
        return value;
    }
    writeArrayBuffer(buffer) {
        const start = this.writeOffset;
        const end = this.checkOverflow(start, buffer.byteLength);
        const src = new Uint8Array(buffer);
        const dest = new Uint8Array(this.arrayBuffer, start);
        dest.set(src);
        this.writeOffset = end;
    }
    writeByteArray(src) {
        const start = this.writeOffset;
        const end = this.checkOverflow(start, src.byteLength);
        const dest = new Uint8Array(this.arrayBuffer, start);
        dest.set(src);
        this.writeOffset = end;
    }
    readWithView(numBytes, reader) {
        const start = this.readOffset;
        const end = this.checkOverflow(start, numBytes);
        const view = new DataView(this.arrayBuffer, start, numBytes);
        const value = reader(view);
        this.readOffset = end;
        return value;
    }
    writeWithView(numBytes, writer) {
        const start = this.writeOffset;
        const end = this.checkOverflow(start, numBytes);
        const view = new DataView(this.arrayBuffer, start, numBytes);
        writer(view);
        this.writeOffset = end;
    }
    /**
     * Advance the read cursor by `numBytes` and return the starting offset.
     * Used to construct a typed-array view directly over the backing store.
     */
    advanceReadOffset(numBytes) {
        const start = this.readOffset;
        this.readOffset = this.checkOverflow(start, numBytes);
        return start;
    }
    /**
     * Advance the write cursor by `numBytes` and return the starting offset.
     * Used to construct a typed-array view directly over the backing store.
     */
    advanceWriteOffset(numBytes) {
        const start = this.writeOffset;
        this.writeOffset = this.checkOverflow(start, numBytes);
        return start;
    }
    /**
     * Set the write cursor to an absolute position. Used to backfill after an
     * in-place encode reports the actual number of bytes written.
     */
    setWriteOffset(offset) {
        if (offset > this.capacity) {
            throw new UniffiInternalError.BufferOverflow();
        }
        this.writeOffset = offset;
    }
    checkOverflow(start, numBytes) {
        const end = start + numBytes;
        if (this.capacity < end) {
            throw new UniffiInternalError.BufferOverflow();
        }
        return end;
    }
}
//# sourceMappingURL=ffi-types.js.map