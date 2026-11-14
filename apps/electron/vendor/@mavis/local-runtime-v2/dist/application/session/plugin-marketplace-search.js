import { buildTextSearchIndex } from '@mavis/agent-tools';
import { InstalledPluginSource, } from '@mavis/thrift-gen/generated/desktop-service/types';
const CACHE_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const RESULT_LIMIT = 5;
/** Indexed text: identity, description, tags, example queries, and ops brand keywords. */
function catalogText(plugin) {
    return [
        plugin.name,
        plugin.displayName,
        plugin.description,
        ...(plugin.tags?.flatMap((tag) => [tag.key, tag.displayName]) ?? []),
        ...(plugin.exampleQueries ?? []),
        ...(plugin.recommendation?.brandKeywords ?? []),
    ]
        .filter(Boolean)
        .join(' ');
}
const LATIN_WORD_OR_HAN_RUN = /[a-z0-9]+|\p{Script=Han}+/gu;
const HAN_RUN = /^\p{Script=Han}+$/u;
/**
 * Match terms for the relevance filter, from lowercased text: whole Latin words
 * (never camel-case pieces, so `GitHub` does not match `GitLab` through `git`)
 * and Han characters plus bigrams (Chinese has no word boundaries).
 */
function matchTerms(text) {
    const terms = [];
    for (const run of text.toLocaleLowerCase().match(LATIN_WORD_OR_HAN_RUN) ?? []) {
        if (!HAN_RUN.test(run)) {
            terms.push(run);
            continue;
        }
        const chars = [...run];
        terms.push(...chars);
        for (let index = 0; index + 1 < chars.length; index += 1) {
            terms.push(chars[index] + chars[index + 1]);
        }
    }
    return terms;
}
/**
 * Han labels match as substrings; Latin labels only on whole-word boundaries;
 * kana / Hangul labels must not continue a preceding same-script word.
 */
function queryContainsLabel(normalizedQuery, label) {
    if (HAN_RUN.test(label.replace(/\s+/gu, '')))
        return normalizedQuery.includes(label);
    let from = 0;
    for (;;) {
        const index = normalizedQuery.indexOf(label, from);
        if (index < 0)
            return false;
        const before = normalizedQuery[index - 1] ?? '';
        const after = normalizedQuery[index + label.length] ?? '';
        if (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after) && !continuesWord(label, before)) {
            return true;
        }
        from = index + 1;
    }
}
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}\u30fc]/u;
const HANGUL = /\p{Script=Hangul}/u;
/**
 * Kana and Hangul have no spaces between words, so a label preceded by the
 * same script sits inside a longer word (`ライン` in `オンライン`, `라인` in
 * `온라인`). Attached suffixes after the label (`ラインワークスで`) still match.
 */
function continuesWord(label, before) {
    if (!before)
        return false;
    const first = label[0] ?? '';
    if (KANA.test(first))
        return KANA.test(before);
    if (HANGUL.test(first))
        return HANGUL.test(before);
    return false;
}
/**
 * How strongly the query names this plugin, as the length of the longest
 * label it equals or contains: the plugin name (equality only), its display
 * name, or a brand keyword (`Notion 笔记` names `notion`). 0 when unnamed;
 * labels shorter than two characters only count on equality. The longest
 * label wins so `飞书项目` prefers the plugin that owns that exact keyword.
 */
function namedMatchLength(plugin, normalizedQuery) {
    let best = plugin.name.toLocaleLowerCase() === normalizedQuery ? [...normalizedQuery].length : 0;
    for (const candidate of [plugin.displayName, ...(plugin.recommendation?.brandKeywords ?? [])]) {
        const label = candidate?.trim().toLocaleLowerCase();
        if (!label)
            continue;
        const length = [...label].length;
        const named = label === normalizedQuery || (length >= 2 && queryContainsLabel(normalizedQuery, label));
        if (named && length > best)
            best = length;
    }
    return best;
}
function rankPlugins(catalog, query) {
    const normalized = query.toLocaleLowerCase().trim();
    const meaningfulTerms = matchTerms(query).filter((term) => [...term].length > 1);
    const scored = new Map(catalog.index
        .search({ query, topK: catalog.plugins.length })
        .map((hit) => [hit.item.name, hit]));
    const named = new Set();
    for (const plugin of catalog.plugins) {
        if (scored.has(plugin.name))
            continue;
        // A query that names the plugin (`onedrive backup` vs `OneDrive`, kana /
        // Hangul keywords the tokenizer drops) is a candidate even without a
        // lexical hit.
        if (namedMatchLength(plugin, normalized) > 0) {
            named.add(plugin.name);
            scored.set(plugin.name, { item: plugin, score: 0 });
        }
        else if (catalogText(plugin).toLocaleLowerCase().includes(normalized)) {
            scored.set(plugin.name, { item: plugin, score: 0 });
        }
    }
    return [...scored.values()]
        .filter(({ item }) => {
        if (named.has(item.name))
            return true;
        const text = catalogText(item).toLocaleLowerCase();
        const terms = new Set(matchTerms(text));
        // A shared single Chinese character alone is too weak to suggest a capability.
        return (text.includes(normalized) ||
            meaningfulTerms.length === 0 ||
            meaningfulTerms.some((term) => terms.has(term)));
    })
        .sort((a, b) => namedMatchLength(b.item, normalized) - namedMatchLength(a.item, normalized) ||
        b.score - a.score ||
        a.item.name.localeCompare(b.item.name))
        .map(({ item }) => item);
}
/**
 * Local lexical search over the full official catalog, independent of the
 * remote keyword filter (which only matches name / displayName substrings).
 */
export function createPluginMarketplaceSearch(list, nowMs = Date.now) {
    async function loadOnce() {
        const entries = new Map();
        const cursors = new Set();
        let cursor;
        let complete = false;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const response = await list({
                source: InstalledPluginSource.OFFICIAL,
                limit: PAGE_SIZE,
                ...(cursor ? { cursor } : {}),
            });
            if (response.cursorResetRequired)
                return 'cursor-reset';
            for (const plugin of response.plugins)
                entries.set(plugin.name, plugin);
            if (!response.hasMore) {
                complete = true;
                break;
            }
            if (!response.nextCursor || cursors.has(response.nextCursor)) {
                throw new Error('Marketplace pagination did not advance. Catalog lookup is incomplete.');
            }
            cursors.add(response.nextCursor);
            cursor = response.nextCursor;
        }
        const plugins = [...entries.values()];
        return {
            plugins,
            complete,
            index: buildTextSearchIndex(plugins, catalogText),
            loadedAt: nowMs(),
        };
    }
    async function load() {
        // The catalog changed mid-walk (ops edited policy): discard and restart once.
        const first = await loadOnce();
        if (first !== 'cursor-reset')
            return first;
        const second = await loadOnce();
        if (second === 'cursor-reset') {
            throw new Error('Marketplace catalog kept changing during lookup. Retry shortly.');
        }
        return second;
    }
    let cached;
    let loading;
    return async (query, cursor, signal) => {
        if (cursor !== undefined && !/^\d{1,6}$/u.test(cursor)) {
            throw new Error('Use the next_cursor returned for this search query.');
        }
        const offset = cursor === undefined ? 0 : Number(cursor);
        signal?.throwIfAborted();
        if (!cached || nowMs() - cached.loadedAt >= CACHE_MS) {
            loading ??= load();
            try {
                cached = await loading;
            }
            finally {
                loading = undefined;
            }
        }
        signal?.throwIfAborted();
        const matches = rankPlugins(cached, query);
        const hasMore = matches.length > offset + RESULT_LIMIT;
        return {
            plugins: matches.slice(offset, offset + RESULT_LIMIT),
            ...(hasMore ? { nextCursor: String(offset + RESULT_LIMIT) } : {}),
            hasMore,
            catalogSize: cached.plugins.length,
            catalogComplete: cached.complete,
        };
    };
}
//# sourceMappingURL=plugin-marketplace-search.js.map