/**
 * Bounded ring buffer used by the TerminalManager to retain PTY output while
 * the renderer is detached. The buffer keeps at most `capacity` items; once
 * full, the oldest entries are dropped to make room for new ones.
 *
 * Two layers:
 *   - `RingBuffer<T>` — generic, useful for tests and unrelated callers.
 *   - `ScrollbackBuffer` — tuned for terminal output: preserves the raw PTY
 *     stream while bounding both line count and UTF-8 byte size.
 *
 * The scrollback default of 10k lines mirrors the design doc (§4.1 / §11).
 * Each chunk may contain multiple lines; the cap measures `\n`-terminated
 * lines. Replay returns the retained suffix without rewriting its contents.
 */

/** Maximum number of lines retained in scrollback when no cap is supplied. */
export let DEFAULT_SCROLLBACK_LINES = 10000;
/** Per-terminal UTF-8 replay budget, independent of newline frequency. */
export let DEFAULT_SCROLLBACK_BYTES = 4 * 1024 * 1024;
const CHUNK_CHARACTERS = 4096;
/**
 * Generic FIFO ring buffer. Items pushed beyond `capacity` evict the oldest.
 */
export class RingBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.items = [];
        if (!Number.isFinite(capacity) || capacity <= 0) {
            throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
        }
    }
    push(item) {
        this.items.push(item);
        const overflow = this.items.length - this.capacity;
        if (overflow > 0) {
            this.items.splice(0, overflow);
        }
    }
    pushAll(items) {
        for (const item of items) {
            this.push(item);
        }
    }
    /** Return a shallow copy of every retained item, oldest first. */
    toArray() {
        return this.items.slice();
    }
    get size() {
        return this.items.length;
    }
    clear() {
        this.items = [];
    }
}

/**
 * A bounded deque of small raw-stream chunks. Append never joins or scans the
 * retained history; only snapshot joins it. Eviction prefers the exact line
 * boundary, or a Unicode/control-sequence boundary when the byte cap wins.
 */
export class ScrollbackBuffer {
    constructor(capacity = DEFAULT_SCROLLBACK_LINES, byteCapacity = DEFAULT_SCROLLBACK_BYTES) {
        this.capacity = capacity;
        this.byteCapacity = byteCapacity;
        this.head = null;
        this.tail = null;
        this.retainedBytes = 0;
        this.completedLineCount = 0;
        // State at the discarded prefix: if eviction crosses an unfinished control
        // sequence, discard its continuation too, even when it arrives later.
        this.boundary = new ReplayBoundary();
        for (const value of [capacity, byteCapacity]) {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new Error(`ScrollbackBuffer capacity must be a positive integer, got ${value}`);
            }
        }
    }
    append(chunk) {
        let offset = 0;
        while (offset < chunk.length) {
            const tail = this.tail;
            // Keep a surrogate pair together even when it straddles append calls.
            const joinsSurrogate = tail &&
                isHighSurrogate(tail.text.charCodeAt(tail.text.length - 1)) &&
                isLowSurrogate(chunk.charCodeAt(offset));
            const available = tail ? CHUNK_CHARACTERS - tail.text.length : CHUNK_CHARACTERS;
            const extend = tail && (available > 0 || joinsSurrogate);
            let end = Math.min(chunk.length, offset + (extend ? Math.max(1, available) : CHUNK_CHARACTERS));
            if (end < chunk.length &&
                isHighSurrogate(chunk.charCodeAt(end - 1)) &&
                isLowSurrogate(chunk.charCodeAt(end)))
                end += 1;
            // Copy a bounded piece: a sliced string must not pin a huge PTY chunk.
            const text = Buffer.from(chunk.slice(offset, end), 'utf16le').toString('utf16le');
            const bytes = Buffer.byteLength(text, 'utf8') - (extend && joinsSurrogate ? 2 : 0);
            const newlines = countNewlines(text);
            if (extend) {
                tail.text += text;
                tail.bytes += bytes;
                tail.newlines += newlines;
            }
            else {
                const next = { text, bytes, newlines, next: null };
                if (tail)
                    tail.next = next;
                else
                    this.head = next;
                this.tail = next;
            }
            this.retainedBytes += bytes;
            this.completedLineCount += newlines;
            offset = end;
            this.trimOverflow();
        }
    }
    /** Replay the retained suffix verbatim: never add LF, resets or markers. */
    snapshot() {
        const parts = [];
        for (let chunk = this.head; chunk; chunk = chunk.next)
            parts.push(chunk.text);
        return parts.join('');
    }
    get byteLength() {
        return this.retainedBytes;
    }
    get lineCount() {
        return this.completedLineCount + (this.tail && !this.tail.text.endsWith('\n') ? 1 : 0);
    }
    clear() {
        this.head = this.tail = null;
        this.retainedBytes = this.completedLineCount = 0;
        this.boundary.reset();
    }
    trimOverflow() {
        while (this.head && this.retainedBytes > this.byteCapacity) {
            const overflow = this.retainedBytes - this.byteCapacity;
            if (this.head.bytes <= overflow) {
                this.dropPrefix(this.head.text.length);
            }
            else {
                let end = 0;
                let bytes = 0;
                const text = this.head.text;
                while (bytes < overflow) {
                    const code = text.codePointAt(end);
                    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
                    end += code > 0xffff ? 2 : 1;
                }
                this.dropPrefix(end);
            }
        }
        while (this.head && this.lineCount > this.capacity) {
            const overflow = this.lineCount - this.capacity;
            if (this.head.newlines < overflow) {
                this.dropPrefix(this.head.text.length);
            }
            else {
                let end = 0;
                for (let i = 0; i < overflow; i += 1)
                    end = this.head.text.indexOf('\n', end) + 1;
                this.dropPrefix(end);
            }
        }
        // Do not replay the middle of CSI/OSC/DCS, including sequences split
        // across input chunks. No control bytes are synthesized for truncation.
        while (this.head && !this.boundary.isGround) {
            const text = this.head.text;
            let end = 0;
            while (end < text.length && !this.boundary.isGround) {
                this.boundary.feed(text.charCodeAt(end++));
            }
            this.dropPrefix(end, true);
        }
    }
    dropPrefix(end, boundaryAlreadyFed = false) {
        const head = this.head;
        const removed = head.text.slice(0, end);
        if (!boundaryAlreadyFed) {
            for (let i = 0; i < removed.length; i += 1)
                this.boundary.feed(removed.charCodeAt(i));
        }
        if (end === head.text.length) {
            this.retainedBytes -= head.bytes;
            this.completedLineCount -= head.newlines;
            this.head = head.next;
            if (!this.head)
                this.tail = null;
        }
        else {
            const bytes = Buffer.byteLength(removed, 'utf8');
            const newlines = countNewlines(removed);
            head.text = head.text.slice(end);
            head.bytes -= bytes;
            head.newlines -= newlines;
            this.retainedBytes -= bytes;
            this.completedLineCount -= newlines;
        }
    }
}

/** Tracks syntax only; terminal rendering and style remain owned by xterm. */
class ReplayBoundary {
    constructor() {
        this.state = 'ground';
    }
    get isGround() {
        return this.state === 'ground';
    }
    reset() {
        this.state = 'ground';
    }
    feed(code) {
        if (code === 0x18 || code === 0x1a || code === 0x9c) {
            this.reset();
            return;
        }
        // Like xterm, ESC ends a control string and starts a new escape. This
        // also handles cancellation by ESC [ rather than waiting forever for ST.
        if (code === 0x1b) {
            this.state = 'escape';
            return;
        }
        if (this.state === 'osc' || this.state === 'string') {
            if (code === 0x07 && this.state === 'osc')
                this.reset();
            return;
        }
        if (code === 0x9b) {
            this.state = 'csi';
            return;
        }
        if (code === 0x9d) {
            this.state = 'osc';
            return;
        }
        if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
            this.state = 'string';
            return;
        }
        if (this.state === 'escapeIntermediate') {
            if (code >= 0x30 && code <= 0x7e)
                this.reset();
        }
        else if (this.state === 'escape') {
            if (code >= 0x20 && code <= 0x2f)
                this.state = 'escapeIntermediate';
            else if (code === 0x5b)
                this.state = 'csi';
            else if (code === 0x5d)
                this.state = 'osc';
            else if ([0x50, 0x58, 0x5e, 0x5f].includes(code))
                this.state = 'string';
            else if (code >= 0x30 && code <= 0x7e)
                this.reset();
        }
        else if (this.state === 'csi' && code >= 0x40 && code <= 0x7e)
            this.reset();
    }
}
function isHighSurrogate(code) {
    return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code) {
    return code >= 0xdc00 && code <= 0xdfff;
}
function countNewlines(value) {
    let count = 0;
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) === 10)
            count += 1;
    }
    return count;
}
