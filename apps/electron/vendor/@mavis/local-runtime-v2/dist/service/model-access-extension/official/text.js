/** Text readers for delivered statements: strict JSON and package version order. */
/**
 * Strict JSON reader for remotely delivered statements. JSON.parse keeps the last duplicate key,
 * while the server rejects duplicates; reading the same document differently would let a
 * statement mean one thing to archon_server and another to Desktop.
 */
class StrictJsonError extends Error {
    constructor() {
        super('invalid_json');
        this.name = 'StrictJsonError';
    }
}
const MAX_DEPTH = 32;
class Reader {
    text;
    index = 0;
    constructor(text) {
        this.text = text;
    }
    document() {
        const value = this.value(0);
        this.whitespace();
        if (this.index !== this.text.length)
            throw new StrictJsonError();
        return value;
    }
    value(depth) {
        if (depth > MAX_DEPTH)
            throw new StrictJsonError();
        this.whitespace();
        const char = this.text[this.index];
        if (char === '{')
            return this.object(depth);
        if (char === '[')
            return this.array(depth);
        if (char === '"')
            return this.string();
        if (char === 't')
            return this.literal('true', true);
        if (char === 'f')
            return this.literal('false', false);
        if (char === 'n')
            return this.literal('null', null);
        return this.number();
    }
    object(depth) {
        this.index += 1;
        // Null prototype: "__proto__" stays an ordinary (rejected-as-unknown) key.
        const result = Object.create(null);
        this.whitespace();
        if (this.text[this.index] === '}') {
            this.index += 1;
            return result;
        }
        for (;;) {
            this.whitespace();
            if (this.text[this.index] !== '"')
                throw new StrictJsonError();
            const key = this.string();
            if (Object.hasOwn(result, key))
                throw new StrictJsonError();
            this.whitespace();
            if (this.text[this.index] !== ':')
                throw new StrictJsonError();
            this.index += 1;
            result[key] = this.value(depth + 1);
            this.whitespace();
            const next = this.text[this.index];
            this.index += 1;
            if (next === '}')
                return result;
            if (next !== ',')
                throw new StrictJsonError();
        }
    }
    array(depth) {
        this.index += 1;
        const result = [];
        this.whitespace();
        if (this.text[this.index] === ']') {
            this.index += 1;
            return result;
        }
        for (;;) {
            result.push(this.value(depth + 1));
            this.whitespace();
            const next = this.text[this.index];
            this.index += 1;
            if (next === ']')
                return result;
            if (next !== ',')
                throw new StrictJsonError();
        }
    }
    string() {
        const start = this.index;
        this.index += 1;
        for (;;) {
            const char = this.text[this.index];
            if (char === undefined || char < ' ')
                throw new StrictJsonError();
            this.index += 1;
            if (char === '"')
                break;
            if (char === '\\')
                this.index += this.text[this.index] === 'u' ? 5 : 1;
        }
        try {
            return JSON.parse(this.text.slice(start, this.index));
        }
        catch {
            throw new StrictJsonError();
        }
    }
    literal(word, value) {
        if (!this.text.startsWith(word, this.index))
            throw new StrictJsonError();
        this.index += word.length;
        return value;
    }
    number() {
        const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.text.slice(this.index));
        if (!match)
            throw new StrictJsonError();
        this.index += match[0].length;
        const value = Number(match[0]);
        if (!Number.isFinite(value))
            throw new StrictJsonError();
        return value;
    }
    whitespace() {
        while (/[ \t\n\r]/u.test(this.text[this.index] ?? ''))
            this.index += 1;
    }
}
/** One JSON document; rejects duplicate keys, trailing content and excessive nesting. */
export function parseStrictJson(text) {
    return new Reader(text).document();
}
/** Version order of delivered extension packages (newer, rollback and revocation choices). */
function versionParts(value) {
    const [main = '', ...suffix] = (value.split('+')[0] ?? '').split('-');
    return { core: main.split('.').map(Number), pre: suffix.join('-').split('.').filter(Boolean) };
}
function comparePart(x, y) {
    if (x === y)
        return 0;
    if (x === undefined || y === undefined)
        return x === undefined ? -1 : 1;
    const nx = /^\d+$/u.test(x);
    const ny = /^\d+$/u.test(y);
    if (nx && ny)
        return Number(x) - Number(y);
    if (nx !== ny)
        return nx ? -1 : 1;
    return x < y ? -1 : 1;
}
/** Semver order: stable releases outrank prereleases of the same core version. */
export function comparePackageVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let i = 0; i < 3; i += 1) {
        const difference = (a.core[i] ?? 0) - (b.core[i] ?? 0);
        if (difference)
            return difference;
    }
    if (!a.pre.length || !b.pre.length)
        return Number(!a.pre.length) - Number(!b.pre.length);
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
        const difference = comparePart(a.pre[i], b.pre[i]);
        if (difference)
            return difference;
    }
    return 0;
}
//# sourceMappingURL=text.js.map