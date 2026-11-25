import { and, count, desc, eq, gt, inArray, isNull, lt, ne, notExists, exists, or, sql, } from 'drizzle-orm';
import { messageRows, newerSessionAssets, sessionAssetIndexState, sessionAssets, } from '../../../../infra/db/schema/messages.js';
import { sessions, sessionSideChats } from '../../../../infra/db/schema/sessions.js';
import { assignedByBunnyCondition } from '../../assignment-tasks/repo/assigned-by-bunny.js';
export const ARTIFACT_EXTENSIONS = {
    document: ['md', 'txt', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'rtf'],
    webpage: ['html', 'htm'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'],
    spreadsheet: ['csv', 'tsv', 'xls', 'xlsx'],
};
const localPath = sql `replace(${sessionAssets.path}, char(92), '/')`;
const name = sql `coalesce(nullif(trim(${sessionAssets.name}), ''), substr(${localPath}, length(rtrim(${localPath}, replace(${localPath}, '/', ''))) + 1))`;
const category = sql `case ${sql.join(Object.entries(ARTIFACT_EXTENSIONS).map(([kind, extensions]) => sql `when ${or(...extensions.map((ext) => sql `lower(${sessionAssets.path}) like ${`%.${ext}`}`))} then ${kind}`), sql ` `)} else 'other' end`;
function libraryRootAgentCondition(rootAgents) {
    return sql `${sessions.agentName} in (select value from json_each(${JSON.stringify(rootAgents)}))`;
}
function visibleSessions(db, { assigned, rootAgents }) {
    return and(eq(sessions.columnarVersion, 3), sql `coalesce(${sessions.purpose}, '') <> 'bunny-initialized'`, or(ne(sessions.visibility, 'hidden'), assignedByBunnyCondition(assigned), and(libraryRootAgentCondition(rootAgents), eq(sessions.sessionType, 'root'), eq(sessions.runtime, 'pi-agent'))), inArray(sessions.sessionKind, ['conversation', 'task', 'cron']), notExists(db
        .select({ id: sessionSideChats.sideSessionId })
        .from(sessionSideChats)
        .where(eq(sessionSideChats.sideSessionId, sessions.sessionId))));
}
export function findArtifactSourceSession(db, visibility, sessionId) {
    return db
        .select()
        .from(sessions)
        .where(and(eq(sessions.sessionId, sessionId), visibleSessions(db, visibility)))
        .get();
}
function latestAssets(db, visibility) {
    return and(visibleSessions(db, visibility), notExists(db
        .select({ id: newerSessionAssets.id })
        .from(newerSessionAssets)
        .where(and(eq(newerSessionAssets.sessionId, sessionAssets.sessionId), eq(newerSessionAssets.assetKey, sessionAssets.assetKey), or(gt(newerSessionAssets.messageCreatedAtMs, sessionAssets.messageCreatedAtMs), and(eq(newerSessionAssets.messageCreatedAtMs, sessionAssets.messageCreatedAtMs), gt(newerSessionAssets.id, sessionAssets.id)))))));
}
function linksJson(links) {
    return JSON.stringify(Object.fromEntries(links));
}
/** Session deliveries, the latest occurrence of each asset of each listed session. */
function sessionDeliveries(db, { links, rootSpaceId, ...visibility }) {
    const linked = sql `(select value from json_each(${linksJson(links)}) where key = ${sessionAssets.sessionId})`;
    // The library's own root chats are never linked to a space: their deliveries go to
    // `rootSpaceId` when there is one, else to none.
    const linkedSpace = rootSpaceId === undefined
        ? linked
        : sql `coalesce(${linked}, case when ${and(libraryRootAgentCondition(visibility.rootAgents), eq(sessions.sessionType, 'root'), eq(sessions.runtime, 'pi-agent'))} then ${rootSpaceId} end)`;
    const source = db
        .select({
        assetKey: sessionAssets.assetKey,
        name: name.as('name'),
        category: category.as('category'),
        path: sessionAssets.path,
        sessionId: sessionAssets.sessionId,
        sessionTitle: sessions.title,
        sessionArchived: sessions.archived,
        workspaceDir: sessions.workspaceDir,
        messageId: sessionAssets.messageId,
        deliveredAtMs: sessionAssets.messageCreatedAtMs,
        spaceId: linkedSpace.as('space_id'),
        updatedAtMs: sql `${sessionAssets.messageCreatedAtMs}`.as('updated_at_ms'),
        origin: sql `'session'`.as('origin'),
        sourceAvailable: sql `1`.as('source_available'),
        externalDelivery: sql `case when ${libraryRootAgentCondition(visibility.rootAgents)} and ${sessions.sessionType} = 'root' or ${assignedByBunnyCondition(visibility.assigned)} then 1 else 0 end`.as('external_delivery'),
    })
        .from(sessionAssets)
        .innerJoin(sessions, eq(sessions.sessionId, sessionAssets.sessionId))
        .where(latestAssets(db, visibility));
    return source.as('catalog');
}
/** An imported file has no session: its ID pairs an empty session ID with its asset key. */
export function findArtifactCatalogRow(db, facts, sessionId, assetKey) {
    if (sessionId === '')
        return facts.imports.find(assetKey);
    const catalog = sessionDeliveries(db, facts);
    return db
        .select()
        .from(catalog)
        .where(and(eq(catalog.sessionId, sessionId), eq(catalog.assetKey, assetKey)))
        .get();
}
/**
 * One page, newest first: delivery time, then session ID, then asset key, all descending. The
 * session deliveries and the imported files are each read in that order and merged; an imported
 * file's empty session ID puts it after the deliveries of the same time.
 */
export function queryArtifactCatalog(db, facts, input) {
    const catalog = sessionDeliveries(db, facts);
    const deliveries = querySessionDeliveries(db, catalog, input);
    // An imported file belongs to no Session, so a session-scoped page lists deliveries only.
    const imports = input.sessionId ? [] : facts.imports.page(input);
    return mergeCatalogPage(deliveries, imports, input.limit);
}
/** Deliveries of the queried scope, in catalog order, at most `limit + 1` rows. */
function querySessionDeliveries(db, catalog, input) {
    const before = input.before;
    return db
        .select()
        .from(catalog)
        .where(and(input.spaceId ? eq(catalog.spaceId, input.spaceId) : undefined, input.sessionId ? eq(catalog.sessionId, input.sessionId) : undefined, before
        ? or(lt(catalog.deliveredAtMs, before.time), and(eq(catalog.deliveredAtMs, before.time), or(lt(catalog.sessionId, before.session), and(eq(catalog.sessionId, before.session), lt(catalog.assetKey, before.key)))))
        : undefined))
        .orderBy(desc(catalog.deliveredAtMs), desc(catalog.sessionId), desc(catalog.assetKey))
        .limit(input.limit + 1)
        .all();
}
/** Interleaves two ordered runs into one page; equal times put the delivery first. */
function mergeCatalogPage(deliveries, imports, limit) {
    const page = [];
    let delivery = 0;
    let imported = 0;
    while (page.length < limit + 1) {
        const next = deliveries[delivery];
        const file = imports[imported];
        if (!next && !file)
            break;
        if (next && (!file || next.deliveredAtMs >= file.deliveredAtMs)) {
            page.push(next);
            delivery += 1;
        }
        else if (file) {
            page.push(file);
            imported += 1;
        }
    }
    return page;
}
export function spaceArtifactCounts(db, facts) {
    const catalog = sessionDeliveries(db, facts);
    const counts = new Map();
    const add = (row) => counts.set(row.spaceId, (counts.get(row.spaceId) ?? 0) + row.count);
    db.select({ spaceId: catalog.spaceId, count: count() })
        .from(catalog)
        .groupBy(sql `${catalog.spaceId}`)
        .all()
        .forEach(add);
    facts.imports.countsBySpace().forEach(add);
    return [...counts].map(([spaceId, total]) => ({ spaceId, count: total }));
}
/**
 * Source chats of a space: the sessions of its artifacts, plus the sessions linked to it in the
 * Bunny store (`linked`). A linked session that is gone or hidden stays listed as unavailable.
 */
export function spaceSourceSessions(db, spaceId, input) {
    const catalog = sessionDeliveries(db, input);
    const sources = db
        .select({
        id: catalog.sessionId,
        title: catalog.sessionTitle,
        workspaceDir: catalog.workspaceDir,
        available: catalog.sourceAvailable,
    })
        .from(catalog)
        .where(and(eq(catalog.spaceId, spaceId), ne(catalog.sessionId, '')))
        .groupBy(catalog.sessionId)
        .all();
    const found = new Map((input.linked.length === 0
        ? []
        : db
            .select({
            id: sessions.sessionId,
            title: sessions.title,
            workspaceDir: sessions.workspaceDir,
        })
            .from(sessions)
            .where(and(sql `${sessions.sessionId} in (select value from json_each(${JSON.stringify(input.linked)}))`, visibleSessions(db, input)))
            .all()).map((row) => [row.id, row]));
    const linked = input.linked.map((id) => {
        const row = found.get(id);
        return {
            id,
            title: row?.title ?? null,
            workspaceDir: row?.workspaceDir ?? null,
            available: row ? id : null,
        };
    });
    return [
        ...new Map([
            ...sources.map((row) => ({ ...row, available: Boolean(row.available) })),
            ...linked.map((row) => ({ ...row, available: Boolean(row.available) })),
        ].map((row) => [
            row.id,
            { ...row, title: row.title ?? '', workspaceDir: row.workspaceDir ?? '' },
        ])).values(),
    ];
}
export function pendingArtifactSessions(db, visibility) {
    return db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .leftJoin(sessionAssetIndexState, eq(sessionAssetIndexState.sessionId, sessions.sessionId))
        .where(and(visibleSessions(db, visibility), or(isNull(sessionAssetIndexState.sessionId), ne(sessionAssetIndexState.status, 'ready'), ne(sessionAssetIndexState.indexVersion, 1), exists(db
        .select({ id: messageRows.id })
        .from(messageRows)
        .where(and(eq(messageRows.sessionId, sessions.sessionId), gt(messageRows.id, sessionAssetIndexState.indexedThroughMessageRowId)))
        .limit(1)))))
        .orderBy(desc(sessions.updatedAtMs))
        .all()
        .map((row) => row.sessionId);
}
//# sourceMappingURL=artifact-catalog.js.map