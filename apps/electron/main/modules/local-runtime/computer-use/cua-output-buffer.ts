import { StringDecoder } from "node:string_decoder";
/** Bound third-party pipe output, including lines that never terminate. */
export function createCuaOutputBuffer(emit, now = Date.now) {
    const decoder = new StringDecoder('utf8');
    const maxChars = 4096;
    let pending = '';
    let truncated = false;
    let windowStart = now();
    let emitted = 0;
    let dropped = 0;
    let ended = false;
    const output = (line) => {
        if (now() - windowStart >= 10000) {
            if (dropped)
                emit(`[CUA output suppressed ${dropped} lines]`);
            windowStart = now();
            emitted = 0;
            dropped = 0;
        }
        if (emitted >= 30) {
            dropped++;
            return;
        }
        emitted++;
        emit(line);
    };
    const consume = (text) => {
        let start = 0;
        while (start < text.length) {
            const newline = text.indexOf('\n', start);
            const end = newline < 0 ? text.length : newline;
            const remaining = maxChars - pending.length;
            pending += text.slice(start, Math.min(end, start + remaining));
            if (end - start > remaining)
                truncated = true;
            if (newline < 0)
                break;
            const line = pending.trim();
            if (line)
                output(line + (truncated ? ' [truncated]' : ''));
            pending = '';
            truncated = false;
            start = newline + 1;
        }
    };
    return {
        write(chunk) {
            if (!ended)
                consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
        },
        end() {
            if (ended)
                return;
            consume(decoder.end());
            if (pending.trim())
                output(pending.trim() + (truncated ? ' [truncated]' : ''));
            if (dropped)
                emit(`[CUA output suppressed ${dropped} lines]`);
            pending = '';
            ended = true;
        },
    };
}
