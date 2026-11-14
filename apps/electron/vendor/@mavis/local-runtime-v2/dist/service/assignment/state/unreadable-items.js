import { stateUnreadableLine } from '../../coordinator-text/index.js';
const OWED_KEY = 'owed:';
const OWED = 'owed';
/** The parts the baseline records as owed. */
export function owedParts(baseline) {
    const owed = new Set();
    for (const key of baseline?.keys() ?? []) {
        if (key.startsWith(OWED_KEY))
            owed.add(key.slice(OWED_KEY.length));
    }
    return owed;
}
/**
 * The baseline change for a part that was due: unread while unreadable parts
 * are skipped records it as owed; otherwise an owed mark is cleared, so a part
 * is never owed once the emergency rebuild is off. A part that was not due
 * changes nothing.
 */
export function settleOwed(updates, part, state) {
    if (!state.due)
        return;
    if (!state.delivered && state.skip)
        updates.set(`${OWED_KEY}${part}`, OWED);
    else if (state.owed)
        updates.set(`${OWED_KEY}${part}`, null);
}
/**
 * The reads of one Turn's optional parts, and what was left out. `skip`: the
 * emergency rebuild is in effect and an unreadable part is skipped on its own.
 */
export class OptionalReads {
    skip;
    left = new Map();
    constructor(skip) {
        this.skip = skip;
    }
    /** A part whose failed read fails the whole block when parts are not skipped. */
    async read(item, read) {
        if (!this.skip)
            return { ok: true, value: await read() };
        try {
            return { ok: true, value: await read() };
        }
        catch {
            this.leave(item);
            return { ok: false };
        }
    }
    /** `read` for a part read synchronously. */
    readSync(item, read) {
        if (!this.skip)
            return { ok: true, value: read() };
        try {
            return { ok: true, value: read() };
        }
        catch {
            this.leave(item);
            return { ok: false };
        }
    }
    /** A part left out without a word when parts are not skipped. */
    readQuietly(item, read) {
        try {
            return { ok: true, value: read() };
        }
        catch {
            if (this.skip)
                this.leave(item);
            return { ok: false };
        }
    }
    /** Records `count` entries of `item` as left out; `detail` names them in the line. */
    leave(item, count = 1, detail) {
        if (!this.skip)
            return;
        const previous = this.left.get(item);
        const details = [previous?.detail, detail].filter(Boolean).join('、');
        this.left.set(item, {
            count: (previous?.count ?? 0) + count,
            ...(details ? { detail: details } : {}),
        });
    }
    has(item) {
        return this.left.has(item);
    }
    /** The delta block line of `item` when it was left out, otherwise none. */
    lines(item) {
        const left = this.left.get(item);
        if (!left)
            return [];
        return [stateUnreadableLine(item, left.detail)];
    }
    /** Everything left out, in the order it was found. */
    skipped() {
        return [...this.left].map(([item, left]) => ({ item, count: left.count }));
    }
}
/** The delta block line of a part left out outside the block's own reads (memory). */
export function unreadableLine(item) {
    return stateUnreadableLine(item);
}
//# sourceMappingURL=unreadable-items.js.map