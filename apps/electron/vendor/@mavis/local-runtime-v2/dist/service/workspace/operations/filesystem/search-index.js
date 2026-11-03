import { basename, extname } from 'node:path';
// Collisions only admit extra candidates; the ordered match still checks every character.
function characterMask(text) {
    let mask = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        mask |= 1 << (code & 31);
    }
    return mask;
}
function isWordBoundary(before, current) {
    return (before === 47 ||
        before === 95 ||
        before === 45 ||
        before === 46 ||
        before === 32 ||
        (before >= 97 && before <= 122 && current >= 65 && current <= 90));
}
function prepare(path, label = path) {
    const original = label.replaceAll('\\', '/').normalize('NFC');
    const text = original.toLowerCase();
    const withoutMarker = text.replace(/\/$/u, '');
    const nameStart = withoutMarker.lastIndexOf('/') + 1;
    const name = withoutMarker.slice(nameStart);
    const boundaries = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const before = original.charCodeAt(i - 1);
        const current = original.charCodeAt(i);
        if (i === 0 || isWordBoundary(before, current)) {
            boundaries[i] = 1;
        }
    }
    return {
        path,
        text,
        boundaries,
        name,
        nameStart,
        stem: name.slice(0, name.length - extname(name).length),
        segments: withoutMarker.split('/'),
        characterMask: characterMask(text),
    };
}
/** Match characters in order; compact runs and word/camel-case boundaries rank first. */
function fuzzyPenalty(entry, characters, start) {
    let cursor = start;
    let first = -1;
    let previous = start - 1;
    let gaps = 0;
    let boundaries = 0;
    for (const character of characters) {
        const position = entry.text.indexOf(character, cursor);
        if (position < 0)
            return undefined;
        if (first < 0)
            first = position;
        else
            gaps += position - previous - 1;
        boundaries += entry.boundaries[position] ?? 0;
        cursor = position + character.length;
        previous = cursor - 1;
    }
    return Math.min(500, gaps * 2 + first - start + entry.name.length * 0.01) - boundaries * 4;
}
function score(entry, query, characters, mask) {
    if ((entry.characterMask & mask) !== mask)
        return undefined;
    const index = entry.text.indexOf(query);
    const tie = entry.text.length * 0.001;
    if (index >= 0) {
        if (entry.name === query)
            return tie;
        if (entry.stem === query)
            return 5 + tie;
        if (entry.name.startsWith(query))
            return 10 + entry.name.length + tie;
        const nameIndex = entry.name.indexOf(query);
        if (nameIndex >= 0)
            return 20 + nameIndex + entry.name.length + tie;
        const segment = entry.segments.findIndex((item) => item.startsWith(query));
        if (segment >= 0)
            return 40 + segment + entry.segments.length - 1 + tie;
        return 80 + index + entry.segments.length - 1 + tie;
    }
    const namePenalty = fuzzyPenalty(entry, characters, entry.nameStart);
    if (namePenalty !== undefined)
        return 1000 + namePenalty + tie;
    const pathPenalty = fuzzyPenalty(entry, characters, 0);
    return pathPenalty === undefined ? undefined : 2000 + pathPenalty + tie;
}
function insert(matches, candidate, limit) {
    const compare = (other) => {
        const difference = candidate.score - other.score;
        if (difference || candidate.path === other.path)
            return difference;
        return candidate.path < other.path ? -1 : 1;
    };
    const worst = matches.at(-1);
    if (matches.length === limit && worst && compare(worst) >= 0)
        return;
    let start = 0;
    let end = matches.length;
    while (start < end) {
        const middle = (start + end) >>> 1;
        const existing = matches[middle];
        if (existing && compare(existing) < 0)
            end = middle;
        else
            start = middle + 1;
    }
    matches.splice(start, 0, candidate);
    if (matches.length > limit)
        matches.pop();
}
/** Prepared once per inventory; queries retain only the requested best matches. */
export class WorkspaceSearchIndex {
    includeDirectories;
    entries = [];
    paths = new Set();
    rootEntry;
    constructor(root, includeDirectories) {
        this.includeDirectories = includeDirectories;
        this.rootEntry = prepare(`${root.replaceAll('\\', '/').replace(/\/$/u, '')}/`, `${basename(root)}/`);
    }
    get size() {
        return this.entries.length;
    }
    add(paths) {
        for (const path of paths) {
            if (this.paths.has(path))
                continue;
            this.paths.add(path);
            this.entries.push(prepare(path));
        }
    }
    search(query, limit = 50) {
        const needle = query.trim().replaceAll('\\', '/').normalize('NFC').toLowerCase();
        if (!needle || limit <= 0)
            return [];
        const maxResults = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50;
        const characters = Array.from(needle.replace(/\s/gu, ''));
        const mask = characterMask(characters.join(''));
        const matches = [];
        const consider = (entry) => {
            const value = score(entry, needle, characters, mask);
            if (value === undefined)
                return;
            const worst = matches.at(-1);
            if (matches.length === maxResults &&
                worst &&
                (value > worst.score || (value === worst.score && entry.path >= worst.path)))
                return;
            insert(matches, { path: entry.path, score: value }, maxResults);
        };
        for (const entry of this.entries)
            consider(entry);
        // A root label never matches its parents, even when using fuzzy path matching.
        if (this.includeDirectories) {
            const value = score(this.rootEntry, needle, characters, mask);
            if (value !== undefined)
                insert(matches, { path: this.rootEntry.path, score: value }, maxResults);
        }
        return matches.map((match) => match.path);
    }
}
//# sourceMappingURL=search-index.js.map