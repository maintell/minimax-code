import { skillForNamespace, summaryForNamespace } from '../shared/builtin-tool-namespaces.js';
import { tokenize } from './tokenize.js';
const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** Added per query term that appears in the item name when name boosting is on. */
const NAME_TOKEN_BOOST = 4;
function flattenSchema(schema, max) {
    const parts = [];
    const walk = (node) => {
        if (!node || typeof node !== 'object')
            return;
        const o = node;
        if (typeof o.description === 'string')
            parts.push(o.description);
        if (Array.isArray(o.enum))
            parts.push(o.enum.map(String).join(' '));
        if (Array.isArray(o.required))
            parts.push(o.required.join(' '));
        if (o.properties && typeof o.properties === 'object') {
            for (const [k, v] of Object.entries(o.properties)) {
                parts.push(k);
                walk(v);
            }
        }
        if (o.items)
            walk(o.items);
    };
    walk(schema);
    return parts.join(' ').slice(0, max);
}
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}
/**
 * Pure, stable content signature for a candidate set. Hashes the sorted
 * `name:namespace:fnv1a(schema):fnv1a(description)` tuples — it intentionally does
 * NOT depend on `maxSchemaTextLen`, so two indexes built from the same candidates
 * (regardless of schema-text truncation) share a signature. `buildIndex` and
 * `buildOrReuseIndex` both route through this so their signatures always agree.
 * The namespace is part of the signature: without it a cache hit could hand back
 * an index built before the tool was namespaced.
 */
export function computeIndexSignature(candidates) {
    return fnv1a([...candidates]
        .map((e) => `${e.tool.def.name}:${e.tool.def.namespace ?? ''}:${fnv1a(JSON.stringify(e.tool.def.schema ?? {}))}:${fnv1a(e.tool.def.description ?? '')}`)
        .sort()
        .join('|'));
}
/** Generic BM25 lexical index; callers keep their own identity and state on `item`. */
export function buildTextSearchIndex(items, textOf, opts = {}) {
    const docs = items.map((item) => {
        const raw = textOf(item);
        const tokens = tokenize(raw);
        const tf = new Map();
        for (const t of tokens)
            tf.set(t, (tf.get(t) ?? 0) + 1);
        const exactNames = opts.exactNamesOf?.(item) ?? [item.name];
        return {
            item,
            raw,
            len: tokens.length,
            tf,
            nameTokens: new Set(tokenize(item.name)),
            exactNames: new Set(exactNames.map((name) => name.toLowerCase())),
        };
    });
    const N = docs.length;
    const df = new Map();
    for (const d of docs)
        for (const t of d.tf.keys())
            df.set(t, (df.get(t) ?? 0) + 1);
    const avgdl = N === 0 ? 0 : docs.reduce((s, d) => s + d.len, 0) / N;
    const idf = (t) => {
        const n = df.get(t) ?? 0;
        return Math.log(1 + (N - n + 0.5) / (n + 0.5));
    };
    function bm25(queryTokens, d) {
        let score = 0;
        for (const qt of new Set(queryTokens)) {
            const f = d.tf.get(qt) ?? 0;
            if (f === 0)
                continue;
            const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / (avgdl || 1));
            score += idf(qt) * ((f * (BM25_K1 + 1)) / denom);
        }
        return score;
    }
    function search(input) {
        let pool = docs;
        const namespace = input.namespace?.trim();
        if (namespace && opts.namespaceOf) {
            const namespaceOf = opts.namespaceOf;
            pool = pool.filter((d) => matchesNamespace(namespaceOf(d.item), namespace));
        }
        if (input.regex) {
            const re = new RegExp(input.regex, 'i');
            pool = pool.filter((d) => re.test(d.raw));
        }
        let scored;
        if (input.query && input.query.trim()) {
            const qt = tokenize(input.query);
            const normalizedQuery = input.query.trim().toLowerCase();
            const uniqueQuery = new Set(qt);
            // A term unique to one item earns the full name boost; terms many names
            // share ("get", "show", "history") earn proportionally less, so generic words
            // in a name do not outrank a precise description match.
            const maxIdf = Math.log(1 + (N + 0.5) / 0.5);
            scored = pool
                .map((d) => {
                let score = bm25(qt, d);
                if (input.nameBoost && score > 0) {
                    if (d.exactNames.has(normalizedQuery))
                        score += 100;
                    for (const t of uniqueQuery) {
                        if (d.nameTokens.has(t))
                            score += (NAME_TOKEN_BOOST * idf(t)) / maxIdf;
                    }
                }
                return { d, score };
            })
                .filter((x) => x.score > 0);
            // `regex` and `namespace` are hard filters; `query` only ranks within
            // them. When the query adds no BM25 signal but a filter narrowed the pool,
            // still return that pool (flat score) so a narrowing filter never silently
            // yields nothing. With no filter in play, a zero-hit query means no match.
            // Either way the caller's paging bounds the result, so the fallback cannot
            // flood the context.
            if (scored.length === 0) {
                if (!input.regex && !namespace)
                    return [];
                scored = pool.map((d) => ({ d, score: 1 }));
            }
        }
        else {
            scored = pool.map((d) => ({ d, score: 1 }));
        }
        scored.sort((a, b) => b.score - a.score || a.d.item.name.localeCompare(b.d.item.name));
        const ranked = input.topK === undefined ? scored : scored.slice(0, Math.max(0, input.topK));
        return ranked.map(({ d, score }) => ({ item: d.item, score }));
    }
    return { search, size: N };
}
function toolHit(tool, score) {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        score,
        ...(tool.namespace === undefined
            ? {}
            : {
                namespace: tool.namespace,
                skill_required: tool.skillRequired,
                ...(tool.skill === undefined ? {} : { skill: tool.skill }),
            }),
    };
}
export function buildIndex(candidates, opts) {
    const tools = candidates.map((e) => {
        const def = e.tool.def;
        const schemaText = flattenSchema(def.schema, opts.maxSchemaTextLen);
        const namespace = def.namespace;
        return {
            name: def.name,
            description: def.description ?? '',
            input_schema: def.schema,
            ...(namespace === undefined
                ? { skillRequired: false }
                : {
                    namespace,
                    skill: skillForNamespace(namespace),
                    // The gate only wraps `on_demand` tools, so a default-loaded namespaced
                    // tool must not be advertised as needing its Skill first.
                    skillRequired: def.loading === 'on_demand',
                }),
            // The namespace is indexed text as well as a filter, so a keyword search
            // for "sidebar" reaches the tools it groups. A tool without one keeps the
            // original text, so an anchored regex such as `^github_` still matches.
            raw: `${namespace === undefined ? '' : `${namespace} `}${def.name} ${def.description ?? ''} ${schemaText}`,
            lowerName: def.name.toLowerCase(),
            bareName: bareToolName(def.name).toLowerCase(),
        };
    });
    const index = buildTextSearchIndex(tools, (tool) => tool.raw, {
        exactNamesOf: (tool) => [tool.lowerName, tool.bareName],
        namespaceOf: (tool) => tool.namespace,
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const byLowerName = new Map();
    for (const t of tools) {
        const group = byLowerName.get(t.lowerName);
        if (group)
            group.push(t);
        else
            byLowerName.set(t.lowerName, [t]);
    }
    /**
     * A case-sensitive match wins; case is folded only when that leaves one tool,
     * so `Foo` and `foo` never shadow each other.
     */
    function lookup(name) {
        const key = name.trim();
        const exact = byName.get(key);
        if (exact)
            return toolHit(exact, 1);
        const lowerKey = key.toLowerCase();
        const folded = byLowerName.get(lowerKey);
        if (folded)
            return folded.length === 1 ? toolHit(folded[0], 1) : undefined;
        // A bare tool name (without the `mcp__<server>__` prefix) resolves only when unique.
        const bare = tools.filter((t) => t.bareName === lowerKey);
        const bareExact = bare.filter((t) => bareToolName(t.name) === key);
        const found = bareExact.length > 0 ? bareExact : bare;
        return found.length === 1 ? toolHit(found[0], 1) : undefined;
    }
    function withPrefix(prefix) {
        const key = prefix.trim().toLowerCase();
        return tools
            .filter((t) => t.lowerName.startsWith(key))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => toolHit(t, 1));
    }
    return {
        search: (input) => index.search(input).map(({ item, score }) => toolHit(item, score)),
        lookup,
        withPrefix,
        names: () => tools.map((t) => t.name),
        size: index.size,
        signature: computeIndexSignature(candidates),
        namespaces: collectNamespaces(tools),
    };
}
function collectNamespaces(entries) {
    const names = [...new Set(entries.map((e) => e.namespace).filter((n) => n !== undefined))];
    return names.sort().map((namespace) => {
        const summary = summaryForNamespace(namespace);
        return summary === undefined ? { namespace } : { namespace, summary };
    });
}
/**
 * A namespace query with a dot is exact; one without a dot also matches every
 * namespace below it, so `sidebar` reaches `sidebar.project`.
 */
function matchesNamespace(value, query) {
    if (value === undefined)
        return false;
    if (query.includes('.'))
        return value === query;
    return value === query || value.startsWith(`${query}.`);
}
/** `mcp__server__tool` → `tool`; names without the MCP prefix are returned unchanged. */
export function bareToolName(name) {
    const match = /^mcp__.+?__(.+)$/u.exec(name);
    return match ? match[1] : name;
}
/** `mcp__server__tool` → `server`; other names (built-in on-demand tools) have no server. */
export function mcpServerOfToolName(name) {
    const match = /^mcp__(.+?)__.+$/u.exec(name);
    return match ? match[1] : undefined;
}
/** The server an entry belongs to: its provenance, else the server segment of its name. */
export function serverOfToolEntry(entry) {
    return entry.serverName ?? mcpServerOfToolName(entry.tool.def.name);
}
/**
 * Module-level bounded LRU of built indexes keyed by content signature. The
 * planner rebuilds candidates every deferred turn; caching by signature avoids
 * redundant per-turn BM25 index construction when the configured MCP tool set is
 * unchanged. Insertion-ordered `Map` doubles as the recency list.
 */
const CACHE_MAX = 16;
const indexCache = new Map();
export function buildOrReuseIndex(candidates, opts) {
    const sig = computeIndexSignature(candidates);
    const hit = indexCache.get(sig);
    if (hit !== undefined) {
        // Move to most-recent: delete + re-set so iteration order tracks recency.
        indexCache.delete(sig);
        indexCache.set(sig, hit);
        return hit;
    }
    const idx = buildIndex(candidates, opts);
    if (indexCache.size >= CACHE_MAX) {
        const oldest = indexCache.keys().next().value;
        if (oldest !== undefined)
            indexCache.delete(oldest);
    }
    indexCache.set(sig, idx);
    return idx;
}
/** Test-only: clear the module-level index cache for deterministic tests. */
export function __resetMcpIndexCacheForTest() {
    indexCache.clear();
}
//# sourceMappingURL=search-index.js.map