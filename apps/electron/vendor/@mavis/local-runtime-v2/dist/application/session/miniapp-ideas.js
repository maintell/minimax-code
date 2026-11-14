import { createHash } from 'node:crypto';
import { SessionKind, SessionStatusView } from '@mavis/thrift-gen/generated/desktop-service/types';
import { isMiniAppIdea } from '@mavis/shared/miniapp-launchpad';
const IDEA_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
function parseMiniAppIdeas(text, sources) {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    if (!Array.isArray(parsed) || parsed.length > 2)
        throw new Error('invalid_request');
    const seen = new Set();
    const titles = new Set();
    const ideas = [];
    for (const v of parsed.filter((value) => Boolean(value) && typeof value === 'object')) {
        const source = sources.find((s) => s.sourceSessionId === v.sourceSessionId);
        const idea = {
            title: v.title,
            subtitle: v.subtitle,
            requirements: v.requirements,
            sourceSessionId: source?.sourceSessionId,
            sourceTitle: source?.sourceTitle,
        };
        if (!isMiniAppIdea(idea) || seen.has(idea.sourceSessionId))
            continue;
        const title = idea.title.trim().toLowerCase();
        if (titles.has(title))
            continue;
        seen.add(idea.sourceSessionId);
        titles.add(title);
        ideas.push(idea);
    }
    if (parsed.length && !ideas.length)
        throw new Error('invalid_request');
    return ideas;
}
/** Small account-scoped cache. Failed requests are cooled down, never replaced with fake ideas. */
export class MiniAppIdeas {
    applications;
    complete;
    readUserInputs;
    readExcludedSessionIds;
    cache = new Map();
    constructor(applications, complete, readUserInputs, readExcludedSessionIds) {
        this.applications = applications;
        this.complete = complete;
        this.readUserInputs = readUserInputs;
        this.readExcludedSessionIds = readExcludedSessionIds;
    }
    async read(accountId, language) {
        const result = await this.readCached(accountId, language);
        // Creation can complete while inference is in flight. Recheck before returning cached or new ideas.
        const excluded = await this.readExcludedSessionIds(accountId, result.map((idea) => idea.sourceSessionId));
        return result.filter((idea) => !excluded.has(idea.sourceSessionId));
    }
    async readCached(accountId, language) {
        const sources = await this.readSources(accountId);
        if (!sources.length)
            return [];
        const fingerprint = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
        const context = JSON.stringify(sources.map(({ modelKey: _modelKey, ...source }) => source));
        const key = `${accountId}:${language}`;
        const cached = this.cache.get(key);
        if (cached &&
            cached.fingerprint === fingerprint &&
            (!cached.failed || cached.retryAt > Date.now()))
            return cached.result;
        // Coalesce bursts and limit inference to at most once per minute even as conversations change.
        if (cached && cached.retryAt > Date.now())
            return (await cached.result).filter((idea) => sources.some((source) => source.sourceSessionId === idea.sourceSessionId));
        const result = this.generate(sources, context, language);
        this.pruneCache();
        this.cache.set(key, {
            fingerprint,
            failed: false,
            retryAt: Date.now() + 60000,
            result,
        });
        try {
            return await result;
        }
        catch (error) {
            const entry = this.cache.get(key);
            if (entry?.result === result) {
                entry.retryAt = Date.now() + 60000;
                entry.failed = true;
            }
            throw error;
        }
    }
    pruneCache() {
        const oldest = this.cache.keys().next().value;
        if (this.cache.size >= 8 && oldest)
            this.cache.delete(oldest);
    }
    async readSources(accountId) {
        const { sessions } = await this.applications.session.query.listSessions({}, { name: 'mavis', limit: 30 });
        const candidates = (sessions ?? []).filter((s) => s.sessionId &&
            !s.archived &&
            s.visibility !== 'hidden' &&
            !s.purpose &&
            s.title?.trim() &&
            s.status?.statusType === SessionStatusView.Idle &&
            (s.sessionKind === SessionKind.Conversation || s.sessionKind === SessionKind.Unknown));
        const excluded = await this.readExcludedSessionIds(accountId, candidates.flatMap((session) => (session.sessionId ? [session.sessionId] : [])));
        const sources = [];
        for (const session of candidates.filter((candidate) => candidate.sessionId && !excluded.has(candidate.sessionId))) {
            if (sources.length === 6)
                break;
            if (!session.sessionId || !session.title)
                continue;
            const messages = await this.readUserInputs(session.sessionId, {
                since: Date.now() - IDEA_LOOKBACK_MS,
            });
            if (messages.length)
                sources.push({
                    sourceSessionId: session.sessionId,
                    sourceTitle: session.title.slice(0, 500),
                    messages,
                    modelKey: JSON.stringify(session.model ?? session.effectiveModel ?? null),
                });
        }
        return sources;
    }
    async generate(sources, context, language) {
        const first = sources[0];
        if (!first)
            return [];
        return parseMiniAppIdeas(await this.complete(first.sourceSessionId, context, language), sources);
    }
    close() {
        this.cache.clear();
    }
}
//# sourceMappingURL=miniapp-ideas.js.map