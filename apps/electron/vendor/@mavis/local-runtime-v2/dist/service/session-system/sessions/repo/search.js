import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { projects } from '../../../../infra/db/schema/projects.js';
import { sessionFtsKeys, sessions } from '../../../../infra/db/schema/sessions.js';
import { latestMessageMatch, messageSnippet, sessionHasMessageMatch, } from '../../messages/repo/search-match.js';
import { isPrimarySessionAgentName, PRIMARY_SESSION_AGENT_NAMES } from '../agent-name.js';
import { sessionInVisibleProject } from '../../shared/project-removal.js';
import { projectKeySql, projectKeysPredicate, workspaceDirsPredicate, } from './drizzle/list-predicates.js';
import { recencyCursorPredicate, recencyOrder } from './pagination.js';
export function writeSessionSearchDocument(db, record) {
    db.insert(sessionFtsKeys).values({ sessionId: record.sessionId }).onConflictDoNothing().run();
    const key = db
        .select({ rowId: sessionFtsKeys.ftsRowId })
        .from(sessionFtsKeys)
        .where(eq(sessionFtsKeys.sessionId, record.sessionId))
        .get();
    if (!key)
        throw new Error(`Session FTS key missing for ${record.sessionId}`);
    db.run(sql `DELETE FROM local_runtime_sessions_fts WHERE rowid = ${key.rowId}`);
    db.run(sql `INSERT INTO local_runtime_sessions_fts(
      rowid, session_id, session_id_terms, agent_name_terms, title_terms,
      workspace_dir_terms, purpose_terms, status_terms, session_type_terms
    ) VALUES (
      ${key.rowId}, ${record.sessionId}, ${toSessionSearchTerms(record.sessionId)},
      ${toSessionSearchTerms(record.agentName)}, ${toSessionSearchTerms(record.title)},
      ${toSessionSearchTerms(record.workspaceDir)}, ${toSessionSearchTerms(record.purpose)},
      ${toSessionSearchTerms(record.status)}, ${toSessionSearchTerms(record.sessionType)}
    )`);
}
export function deleteSessionSearchDocument(db, sessionId) {
    const key = db
        .select({ rowId: sessionFtsKeys.ftsRowId })
        .from(sessionFtsKeys)
        .where(eq(sessionFtsKeys.sessionId, sessionId))
        .get();
    if (key)
        db.run(sql `DELETE FROM local_runtime_sessions_fts WHERE rowid = ${key.rowId}`);
}
/**
 * 搜索的第一阶段：标题搜索文档命中关键词的 Session，和 Session 列表一样按最近更新顺序排列
 * （需求是“标题命中优先，同级按更新时间倒序”）。FTS 子查询只算一次，之后沿最近更新索引遍历
 * Session，取前 `limit + 1` 个落在命中集合里的。
 */
export function searchSessionIds(db, options) {
    const keyword = normalizeSearchText(options.keyword);
    const query = toSessionSearchMatch(keyword);
    if (!query)
        return { sessionIds: [], hasMore: false };
    const fingerprint = searchFingerprint(options);
    const cursor = decodeSearchCursor(options.cursor, fingerprint);
    // 内容游标只会在标题匹配全部返回之后发出。
    if (cursor?.kind === 'content')
        return { sessionIds: [], hasMore: false };
    // 一元加号让这个条件不参与选索引：从 FTS 命中反查 Session 的话，最近更新顺序得临时排序。
    const rows = recencySearchRows(db, options, cursor?.after, [
        sql `+${sessions.sessionId} IN (${titleMatchSessionIds(query)})`,
    ]);
    const page = rows.slice(0, options.limit);
    const hasMore = rows.length > options.limit;
    return {
        sessionIds: page.map(({ sessionId }) => sessionId),
        hasMore,
        ...(hasMore ? { nextCursor: encodeSearchCursor('title', page.at(-1), fingerprint) } : {}),
        // 标题命中的会话如果正文也命中，同样带上片段，界面上标题和正文都能看到命中。
        messageMatches: page.flatMap(({ sessionId }) => sessionMessageMatch(db, sessionId, options.keyword)),
    };
}
/**
 * 搜索的第二阶段，接在全部标题匹配之后：找出有消息按 `sessionHasMessageMatch` 命中关键词、
 * 但标题搜索文档没命中的 Session，按 Session 列表的最近更新顺序排列。沿最近更新索引逐个遍历
 * Session，每个都通过消息行索引检查，直到命中 `limit + 1` 个 Session。
 */
export function searchSessionContentIds(db, options) {
    const keyword = normalizeSearchText(options.keyword);
    const query = toSessionSearchMatch(keyword);
    if (!query)
        return { sessionIds: [], hasMore: false };
    const fingerprint = searchFingerprint(options);
    const cursor = decodeSearchCursor(options.cursor, fingerprint);
    const rows = recencySearchRows(db, options, cursor?.kind === 'content' ? cursor.after : undefined, [
        sql `${sessions.sessionId} NOT IN (${titleMatchSessionIds(query)})`,
        sessionHasMessageMatch(sessions.sessionId, options.keyword),
    ]);
    const page = rows.slice(0, options.limit);
    const hasMore = rows.length > options.limit;
    return {
        sessionIds: page.map(({ sessionId }) => sessionId),
        hasMore,
        ...(hasMore ? { nextCursor: encodeSearchCursor('content', page.at(-1), fingerprint) } : {}),
        messageMatches: page.flatMap(({ sessionId }) => sessionMessageMatch(db, sessionId, options.keyword)),
    };
}
/** 两个阶段共用的遍历：可搜索的 Session 从游标位置起按最近更新顺序往下走，取满足条件的前 `limit + 1` 个。 */
function recencySearchRows(db, options, after, match) {
    return db
        .select({
        sessionId: sessions.sessionId,
        updatedAtMs: sessions.updatedAtMs,
        createdAtMs: sessions.createdAtMs,
    })
        .from(sessions)
        .where(and(searchableSessionPredicate(options), recencyCursorPredicate(after), ...match))
        .orderBy(...recencyOrder())
        .limit(options.limit + 1)
        .all();
}
/** 标题搜索文档命中关键词的 Session id。 */
function titleMatchSessionIds(query) {
    return sql `SELECT session_id FROM local_runtime_sessions_fts
    WHERE local_runtime_sessions_fts MATCH ${query}`;
}
/** 本页 Session 所属项目的 key，会话表按 `project_id` 连项目表一次读出，键是 sessionId。 */
export function sessionProjectKeys(db, records) {
    if (records.length === 0)
        return {};
    return Object.fromEntries(db
        .select({ sessionId: sessions.sessionId, projectKey: projectKeySql() })
        .from(sessions)
        .innerJoin(projects, eq(projects.projectId, sessions.projectId))
        .where(inArray(sessions.sessionId, records.map(({ sessionId }) => sessionId)))
        .all()
        .map(({ sessionId, projectKey }) => [sessionId, projectKey]));
}
/** 本页每个 Session 再按索引查一次，取最新的命中消息；正文没有命中就没有。 */
function sessionMessageMatch(db, sessionId, keyword) {
    const row = db.get(latestMessageMatch(sessionId, keyword));
    return row
        ? [{ sessionId, messageId: row.messageId, snippet: messageSnippet(row.text, keyword) }]
        : [];
}
/**
 * 标题搜索和内容搜索会返回的 Session，也就是用户在侧栏能看到的 Session：已从侧栏移除的项目里的
 * 任务不算。再按筛选条件收窄：只看选中的工作目录，要求包含归档时不再排除归档。
 */
function searchableSessionPredicate(scope) {
    // 项目 key 和侧栏的项目一致；传了就以它为准，工作目录只给还不认项目 key 的旧调用方用。
    const workspaces = scope.projectKeys?.length
        ? projectKeysPredicate(scope.projectKeys)
        : workspaceDirsPredicate(scope.workspaceDirs);
    return sql `${sessions.columnarVersion} = 3
    ${scope.includeArchived ? sql `` : sql `AND ${sessions.archived} = 0`}
    AND ${sessions.visibility} <> 'hidden'
    AND ${sessions.sessionKind} NOT IN ('peek', 'cron')
    AND ${sessionInVisibleProject()}
    ${primaryAgentSearchPredicate(scope.agentName)}
    ${workspaces ? sql `AND ${workspaces}` : sql ``}`;
}
function primaryAgentSearchPredicate(agentName) {
    if (!agentName)
        return sql ``;
    // 一元加号让含两个名字的 IN 不参与选索引：按名字分段走索引的话，最近更新顺序得临时排序。
    return isPrimarySessionAgentName(agentName)
        ? sql `AND +${sessions.agentName} IN (${PRIMARY_SESSION_AGENT_NAMES[0]}, ${PRIMARY_SESSION_AGENT_NAMES[1]})`
        : sql `AND ${sessions.agentName} = ${agentName}`;
}
function toSessionSearchTerms(value) {
    if (!value)
        return '';
    return [...normalizeSearchText(value)]
        .map((character) => `c${character.codePointAt(0)?.toString(16) ?? ''}`)
        .join(' ');
}
function toSessionSearchMatch(keyword) {
    const terms = toSessionSearchTerms(keyword);
    return terms ? `"${terms}"` : '';
}
function normalizeSearchText(value) {
    return value.normalize('NFKC').trim().toLowerCase();
}
/**
 * 标识游标属于哪一次搜索。哈希的是用户输入的原样关键词：消息文本按字面匹配它，
 * 标题匹配它规范化后的形式，所以指纹相同就说明匹配结果相同。筛选条件也算进去，
 * 换了项目或归档范围，旧游标就作废；不带筛选时指纹和之前一样。
 */
function searchFingerprint(options) {
    const hash = createHash('sha256')
        .update(options.keyword.trim())
        .update('\u0000')
        .update(options.agentName ?? '');
    if (options.workspaceDirs?.length) {
        hash.update('\u0000workspaces\u0000').update(options.workspaceDirs.join('\u0000'));
    }
    if (options.projectKeys?.length) {
        hash.update('\u0000projects\u0000').update(options.projectKeys.join('\u0000'));
    }
    if (options.includeArchived)
        hash.update('\u0000archived');
    return hash.digest('base64url');
}
const CURSOR_KINDS = { title: 'search-title', content: 'search-content' };
/** 标题游标总带位置；内容游标没有位置表示标题匹配填满了这一页，内容匹配从头开始。 */
function encodeSearchCursor(kind, last, fingerprint) {
    // 写入 Session 和 v3 回填都一定会存 created_at_ms，这里的兜底只是照搬 Session 列表游标
    // 解码 NULL 时的做法。
    const position = last
        ? { u: last.updatedAtMs, c: last.createdAtMs ?? last.updatedAtMs, s: last.sessionId }
        : {};
    return Buffer.from(JSON.stringify({ v: 1, k: CURSOR_KINDS[kind], f: fingerprint, ...position })).toString('base64url');
}
/** 旧版按 FTS 相关度翻页的标题游标（`k: 'search'`）不再认，按没有游标处理，从第一页开始。 */
function decodeSearchCursor(value, fingerprint) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (!isRecord(parsed) || parsed.v !== 1 || parsed.f !== fingerprint)
            return undefined;
        return decodeSearchCursorBody(parsed);
    }
    catch {
        return undefined;
    }
}
function decodeSearchCursorBody(parsed) {
    const kind = ['title', 'content'].find((name) => CURSOR_KINDS[name] === parsed.k);
    if (!kind)
        return undefined;
    if (kind === 'content' && parsed.s === undefined)
        return { kind };
    const after = decodeRecencyPosition(parsed);
    return after ? { kind, after } : undefined;
}
function decodeRecencyPosition(parsed) {
    if (!Number.isSafeInteger(parsed.u) ||
        !Number.isSafeInteger(parsed.c) ||
        typeof parsed.s !== 'string' ||
        !parsed.s) {
        return undefined;
    }
    return {
        updatedAtMs: parsed.u,
        createdAtMs: parsed.c,
        sessionId: parsed.s,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=search.js.map