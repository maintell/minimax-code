/**
 * OSC (Operating System Command) title parser — extracts terminal title
 * sequences from PTY output so the UI can keep tab labels in sync with the
 * shell prompt.
 *
 * Supported forms (per design doc §4.1):
 *   - `ESC ] 0 ; <title> BEL`        — both icon and window title
 *   - `ESC ] 1 ; <title> BEL`        — icon name only (rare)
 *   - `ESC ] 2 ; <title> BEL`        — window title
 *   - String terminator `ESC \\` is treated as equivalent to BEL.
 *
 * The parser is stateful so that an OSC sequence split across two chunks
 * (a common case under high-throughput PTY output) is still recognized: any
 * trailing partial sequence is buffered and re-fed to the next call.
 *
 * The buffer is bounded to prevent unbounded growth from a malformed stream
 * that opens an OSC sequence but never terminates it.
 */

/** ESC byte (0x1B). */
const ESC = '\x1B';
/** Bell terminator (0x07). */
const BEL = '\x07';
/** ESC ] (CSI-like introducer for OSC). */
const OSC_INTRO = `${ESC}]`;
/** Cap on retained partial-sequence buffer (bytes). */
const MAX_PARTIAL_BUFFER = 4096;
/**
 * Stateful parser for OSC 0/1/2 title sequences.
 *
 * Usage:
 *   const parser = new OscTitleParser();
 *   const titles = parser.feed(chunkA); // []
 *   const titles2 = parser.feed(chunkB); // ['my-title']
 */
export class OscTitleParser {
    constructor() {
        /** Carried-over fragment that may contain the start of an OSC sequence. */
        this.partial = '';
    }
    /**
     * Consume a chunk of PTY output and return any complete OSC title strings
     * found. Each returned string is a fully decoded title — no escape codes.
     */
    feed(chunk) {
        if (!chunk)
            return [];
        const titles = [];
        let buffer = this.partial + chunk;
        this.partial = '';
        while (buffer.length > 0) {
            const introIndex = buffer.indexOf(OSC_INTRO);
            if (introIndex === -1) {
                // No OSC start — discard everything except the trailing ESC (which
                // might be the start of a sequence whose `]` arrives next chunk).
                if (buffer.endsWith(ESC)) {
                    this.partial = ESC;
                }
                return titles;
            }
            // Skip past the `ESC]` introducer.
            const afterIntro = introIndex + OSC_INTRO.length;
            // Need at least `<digit>;` to even consider this a title sequence.
            if (afterIntro >= buffer.length) {
                // Sequence opens at end of buffer — defer.
                this.partial = buffer.slice(introIndex);
                this.capPartial();
                return titles;
            }
            const ps = buffer[afterIntro];
            if (ps !== '0' && ps !== '1' && ps !== '2') {
                // Other Ps codes (set palette, etc.) — skip the introducer and
                // continue scanning for the next OSC opener.
                buffer = buffer.slice(afterIntro);
                continue;
            }
            // Expect `;` after the digit; if not present, drop this introducer
            // and keep scanning to avoid getting stuck.
            const semicolonIndex = afterIntro + 1;
            if (semicolonIndex >= buffer.length) {
                this.partial = buffer.slice(introIndex);
                this.capPartial();
                return titles;
            }
            if (buffer[semicolonIndex] !== ';') {
                buffer = buffer.slice(afterIntro + 1);
                continue;
            }
            const titleStart = semicolonIndex + 1;
            const remainder = buffer.slice(titleStart);
            const terminator = findTerminator(remainder);
            if (!terminator) {
                // Title not terminated yet — buffer the unfinished sequence.
                this.partial = buffer.slice(introIndex);
                this.capPartial();
                return titles;
            }
            const title = remainder.slice(0, terminator.index);
            titles.push(title);
            buffer = remainder.slice(terminator.index + terminator.length);
        }
        return titles;
    }
    /** Reset internal carry-over buffer. */
    reset() {
        this.partial = '';
    }
    capPartial() {
        if (this.partial.length > MAX_PARTIAL_BUFFER) {
            // Drop the oldest bytes — keep only the tail so a delayed terminator
            // still has a chance to land.
            this.partial = this.partial.slice(-MAX_PARTIAL_BUFFER);
        }
    }
}

/**
 * Find the OSC string terminator in a buffer. Returns the offset and the
 * length of the terminator (BEL = 1, ESC \\ = 2), or `null` if neither is
 * present.
 */
function findTerminator(text) {
    const belIndex = text.indexOf(BEL);
    const stIndex = text.indexOf(`${ESC}\\`);
    if (belIndex === -1 && stIndex === -1)
        return null;
    if (belIndex === -1)
        return { index: stIndex, length: 2 };
    if (stIndex === -1)
        return { index: belIndex, length: 1 };
    return belIndex < stIndex ? { index: belIndex, length: 1 } : { index: stIndex, length: 2 };
}
