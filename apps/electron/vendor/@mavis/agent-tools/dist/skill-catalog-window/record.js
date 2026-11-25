import { skillSnapshot } from './deviation.js';
import { SKILL_AVAILABILITY_NOTICE_TAG, userMessageText } from './notice.js';
import { adoptSkillCatalogSessionState, disposeSkillCatalogSession, forgetSkillCatalogAnnouncements, peekSkillCatalogSessionState, } from './state.js';
const RECORD_VERSION = 1;
/** The Session's state as a record; undefined when this process keeps none. */
export function exportSkillCatalogSession(sessionId) {
    const state = peekSkillCatalogSessionState(sessionId);
    if (!state)
        return undefined;
    return {
        version: RECORD_VERSION,
        ...(state.window ? { window: windowRecord(state.window) } : {}),
        ...(state.told ? { told: deviationPairs(state.told) } : {}),
        everTold: state.everTold,
        ...(state.newestNotice === undefined ? {} : { newestNotice: state.newestNotice }),
        addedInWindow: [...state.addedInWindow],
        changedInWindow: [...state.changedInWindow],
        ...(state.pending
            ? {
                pending: {
                    text: state.pending.text,
                    deviation: deviationPairs(state.pending.deviation),
                    confirmed: state.pending.confirmed,
                },
            }
            : {}),
        historyChecked: state.historyChecked,
        ...(state.lastSummaryKey === undefined ? {} : { lastSummaryKey: state.lastSummaryKey }),
        endedByCompaction: state.endedByCompaction,
        everEffective: state.everEffective,
        ...(state.turn
            ? {
                turn: {
                    listing: [...state.turn.listing],
                    live: snapshotEntries(state.turn.live),
                    shadow: state.turn.shadow,
                },
            }
            : {}),
    };
}
/**
 * Replaces the Session's process-local state with `record` before its first
 * Turn in this process; undefined (none stored) clears it, so the next Turn
 * starts a window. Returns false, leaving no state, when the record is not one
 * this version reads. With `history` (the stored messages the Turn continues),
 * updates the record counts as told but the history no longer shows as the
 * newest (a rewind, or a record older than the history) become unknown, as
 * `forgetSkillCatalogAnnouncements` makes them.
 */
export function restoreSkillCatalogSession(sessionId, record, history) {
    disposeSkillCatalogSession(sessionId);
    if (record === undefined)
        return true;
    let state;
    try {
        state = parseRecord(record);
    }
    catch {
        return false;
    }
    adoptSkillCatalogSessionState(sessionId, state);
    if (history && !historyShowsTold(state, history))
        forgetSkillCatalogAnnouncements(sessionId);
    return true;
}
/**
 * The newest update in the history is the one the state last sent; with none
 * there, nothing it still counts as told was lost (it told no deviation, or a
 * compaction dropped an update that said all Skills are as shown).
 */
function historyShowsTold(state, history) {
    const text = newestNoticeHolder(history);
    if (text === undefined)
        return !state.told?.size;
    const notice = state.newestNotice;
    if (notice === undefined)
        return false;
    const sent = text.lastIndexOf(notice);
    const newest = text.lastIndexOf(SKILL_AVAILABILITY_NOTICE_TAG);
    return sent !== -1 && sent + notice.indexOf(SKILL_AVAILABILITY_NOTICE_TAG) === newest;
}
/** Text of the newest user message carrying an update. */
function newestNoticeHolder(messages) {
    for (let at = messages.length - 1; at >= 0; at -= 1) {
        const text = userMessageText(messages[at]);
        if (text?.includes(SKILL_AVAILABILITY_NOTICE_TAG))
            return text;
    }
    return undefined;
}
function windowRecord(window) {
    const { render } = window;
    return {
        entries: snapshotEntries(window.entries),
        usage: [...window.usage].map(([key, usage]) => [
            key,
            {
                useCount: usage.useCount,
                lastUsedAtMs: usage.lastUsedAtMs,
                ...(usage.firstSeenAtMs === undefined ? {} : { firstSeenAtMs: usage.firstSeenAtMs }),
            },
        ]),
        render: {
            catalog: render.catalog,
            descriptionsDropped: render.descriptionsDropped,
            nameOnly: [...render.nameOnly],
            descriptionCapTruncated: render.descriptionCapTruncated,
            catalogTokens: render.catalogTokens,
        },
        listing: [...window.listing],
        ...(window.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: window.contextWindowTokens }),
        upstreamFingerprint: window.upstreamFingerprint,
        startedAtMs: window.startedAtMs,
    };
}
function snapshotEntries(snapshot) {
    return [...snapshot.values()].map(({ entry }) => ({
        name: entry.name,
        description: entry.description,
        builtin: entry.builtin,
    }));
}
function deviationPairs(deviations) {
    return [...deviations].map(([key, deviation]) => [
        key,
        {
            status: deviation.status,
            name: deviation.name,
            ...(deviation.signature === undefined ? {} : { signature: deviation.signature }),
        },
    ]);
}
class MalformedSkillCatalogRecord extends Error {
}
function parseRecord(value) {
    const record = object(value);
    if (record.version !== RECORD_VERSION)
        throw new MalformedSkillCatalogRecord();
    const window = optional(record.window, parseWindow);
    const told = optional(record.told, (pairs) => map(pairs, parseDeviation));
    const newestNotice = optional(record.newestNotice, string);
    const pending = optional(record.pending, (raw) => {
        const fields = object(raw);
        return {
            text: string(fields.text),
            deviation: map(fields.deviation, parseDeviation),
            confirmed: boolean(fields.confirmed),
        };
    });
    const lastSummaryKey = optional(record.lastSummaryKey, string);
    const turn = optional(record.turn, (raw) => {
        const fields = object(raw);
        return {
            listing: map(fields.listing, parseListing),
            live: skillSnapshot(list(fields.live, parseEntry)),
            shadow: boolean(fields.shadow),
        };
    });
    return {
        ...(window ? { window } : {}),
        told,
        everTold: boolean(record.everTold),
        ...(newestNotice === undefined ? {} : { newestNotice }),
        addedInWindow: map(record.addedInWindow, string),
        changedInWindow: new Set(list(record.changedInWindow, string)),
        ...(pending ? { pending } : {}),
        historyChecked: boolean(record.historyChecked),
        ...(lastSummaryKey === undefined ? {} : { lastSummaryKey }),
        endedByCompaction: boolean(record.endedByCompaction),
        everEffective: boolean(record.everEffective),
        ...(turn ? { turn } : {}),
    };
}
function parseWindow(value) {
    const fields = object(value);
    const render = object(fields.render);
    return {
        entries: skillSnapshot(list(fields.entries, parseEntry)),
        usage: map(fields.usage, (raw) => {
            const usage = object(raw);
            const firstSeenAtMs = optional(usage.firstSeenAtMs, number);
            return {
                useCount: number(usage.useCount),
                lastUsedAtMs: number(usage.lastUsedAtMs),
                ...(firstSeenAtMs === undefined ? {} : { firstSeenAtMs }),
            };
        }),
        render: {
            catalog: string(render.catalog),
            descriptionsDropped: number(render.descriptionsDropped),
            nameOnly: new Set(list(render.nameOnly, string)),
            descriptionCapTruncated: boolean(render.descriptionCapTruncated),
            catalogTokens: number(render.catalogTokens),
        },
        listing: map(fields.listing, parseListing),
        contextWindowTokens: optional(fields.contextWindowTokens, number),
        upstreamFingerprint: string(fields.upstreamFingerprint),
        startedAtMs: number(fields.startedAtMs),
    };
}
function parseEntry(value) {
    const fields = object(value);
    return {
        name: string(fields.name),
        description: string(fields.description),
        builtin: boolean(fields.builtin),
    };
}
function parseDeviation(value) {
    const fields = object(value);
    const status = fields.status;
    if (status !== 'added' && status !== 'removed' && status !== 'changed') {
        throw new MalformedSkillCatalogRecord();
    }
    const signature = optional(fields.signature, string);
    return {
        status,
        name: string(fields.name),
        ...(signature === undefined ? {} : { signature }),
    };
}
function parseListing(value) {
    if (value === 'described' || value === 'name_only')
        return value;
    throw new MalformedSkillCatalogRecord();
}
function object(value) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
    }
    throw new MalformedSkillCatalogRecord();
}
function list(value, item) {
    if (!Array.isArray(value))
        throw new MalformedSkillCatalogRecord();
    return value.map((raw) => item(raw));
}
function map(value, item) {
    return new Map(list(value, (pair) => {
        if (!Array.isArray(pair) || pair.length !== 2)
            throw new MalformedSkillCatalogRecord();
        return [string(pair[0]), item(pair[1])];
    }));
}
function optional(value, parse) {
    return value === undefined ? undefined : parse(value);
}
function string(value) {
    if (typeof value === 'string')
        return value;
    throw new MalformedSkillCatalogRecord();
}
function number(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    throw new MalformedSkillCatalogRecord();
}
function boolean(value) {
    if (typeof value === 'boolean')
        return value;
    throw new MalformedSkillCatalogRecord();
}
//# sourceMappingURL=record.js.map