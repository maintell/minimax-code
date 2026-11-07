import { toNavigationPlainText } from '@mavis/shared/navigation-text';
import { sql } from 'drizzle-orm';
import { messageRows } from '../../../../infra/db/schema/messages.js';
import { INTERNAL_USER_SOURCES, SYNTHETIC_RESPONSE_MARKERS } from '../input-navigation/text.js';
/** 片段取关键词前 20 个、后 60 个码点。 */
const SNIPPET_BEFORE = 20;
const SNIPPET_AFTER = 60;
/** 正文里找不到关键词时，片段取开头这么多个码点。 */
const SNIPPET_FALLBACK = SNIPPET_BEFORE + SNIPPET_AFTER;
/**
 * Session 里有没有文本包含 `keyword` 的消息。匹配用的是 `LIKE`，所以只有 ASCII 字母不分大小写。
 * 只搜用户眼里的对话内容：
 * - 用户自己输入或 steer 的 user 行：不是内部来源，也不是替用户发出的问卷回复或权限回复。
 * - 每轮最后一条有文本的 assistant 行，也就是最终回答。调用工具前的说明、思考、
 *   工具行和卡片都不搜。
 * - 没有 turn id 的行按每条 user 行切成多轮，再用同样的规则挑。
 * 消息行只通过 `(session_id, role, id)` 和 `(session_id, turn_id, role, id)` 这两个索引读取：
 * `data_json` 占的页很大，对消息表的任何扫描都会把整张表读一遍。
 */
export function sessionHasMessageMatch(sessionId, keyword) {
    const exists = matchingRowIds(sessionId, keyword).map((ids) => sql `EXISTS (${ids})`);
    return sql `(${sql.join(exists, sql ` OR `)})`;
}
/**
 * Session 里最新的一条命中消息：在 `sessionHasMessageMatch` 的三类候选行里取 id 最大的，
 * 再按主键读出它的 `msg_id` 和正文。
 */
export function latestMessageMatch(sessionId, keyword) {
    const candidates = sql.join(matchingRowIds(sql.param(sessionId), keyword), sql ` UNION ALL `);
    return sql `SELECT r.msg_id AS messageId, CAST(${text('r')} AS TEXT) AS text
    FROM ${messageRows} AS r
    WHERE r.id = (SELECT max(id) FROM (${candidates}))`;
}
/**
 * 命中消息里关键词前后的一小段。片段是给人看的，先用消息导航同一套投影把正文转成可读文本
 * （去掉代码围栏、强调、链接等 Markdown 记号和协议标签），代码块和行内代码保持原文；关键词本身
 * 带这些记号、可读文本里找不到时，退回原文，保证片段里有命中的关键词。和 `LIKE` 一样找关键词
 * 第一次出现的位置，只有 ASCII 字母不分大小写。按码点截取，被截掉的一头加 `…`，空白压成一个空格。
 */
export function messageSnippet(content, keyword) {
    const needle = keyword.trim();
    const readable = readableText(content);
    const shown = readable && (locate(readable, needle) >= 0 || locate(content, needle) < 0) ? readable : content;
    const found = locate(shown, needle);
    // 找不到时当作关键词在开头、长度为 0，往后多取一些。
    const start = Math.max(found, 0);
    const end = found < 0 ? 0 : found + needle.length;
    const afterLimit = found < 0 ? SNIPPET_FALLBACK : SNIPPET_AFTER;
    const before = [...shown.slice(0, start)];
    const after = [...shown.slice(end)];
    const body = [
        ...before.slice(-SNIPPET_BEFORE),
        shown.slice(start, end),
        ...after.slice(0, afterLimit),
    ]
        .join('')
        .replace(/\s+/gu, ' ')
        .trim();
    return `${before.length > SNIPPET_BEFORE ? '…' : ''}${body}${after.length > afterLimit ? '…' : ''}`;
}
function locate(haystack, needle) {
    return foldAsciiCase(haystack).indexOf(foldAsciiCase(needle));
}
/** 占位符用私用区字符，正文里原有的这两个字符先去掉，避免和占位符混淆。 */
const CODE_OPEN = '\uE000';
const CODE_CLOSE = '\uE001';
const CODE_PLACEHOLDER_RE = /\uE000(\d+)\uE001/gu;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/u;
const INLINE_CODE_RE = /(`+)(.+?)\1/gu;
/**
 * 消息导航的投影会把代码当 Markdown 处理，比如两个带下划线的名字之间被当成一段斜体去掉下划线。
 * 所以先把围栏代码块和行内代码换成占位符，投影完再换回原文（去掉围栏和反引号）。代码块的语言
 * 标记保留在代码前面，和对话里代码块顶上显示的一样；否则只在标记里命中时片段会退回带围栏的原文。
 */
function readableText(content) {
    const code = [];
    const protect = (literal) => `${CODE_OPEN}${code.push(literal.replace(/\s+/gu, ' ').trim()) - 1}${CODE_CLOSE}`;
    const lines = content
        .replace(/[\uE000\uE001]/gu, '')
        .replace(/\r\n?/gu, '\n')
        .split('\n');
    const prose = [];
    let fence;
    let body = [];
    for (const line of lines) {
        const marker = FENCE_RE.exec(line)?.[1];
        if (fence === undefined && marker) {
            fence = marker;
            const language = line.trim().slice(marker.length).trim().split(/\s+/u)[0];
            body = language ? [language] : [];
        }
        else if (fence === undefined) {
            prose.push(line.replace(INLINE_CODE_RE, (_match, _ticks, inner) => protect(inner)));
        }
        else if (marker?.startsWith(fence) && line.trim() === marker) {
            prose.push(protect(body.join('\n')));
            fence = undefined;
        }
        else {
            body.push(line);
        }
    }
    if (fence !== undefined)
        prose.push(protect(body.join('\n')));
    return toNavigationPlainText(prose.join('\n')).replace(CODE_PLACEHOLDER_RE, (_match, index) => code[Number(index)] ?? '');
}
/** 正文命中关键词的候选行 id，分三类：用户输入、有 turn id 的最终回答、没有 turn id 的最终回答。 */
function matchingRowIds(sessionId, keyword) {
    const pattern = `%${keyword.trim().replace(/[!%_]/gu, '!$&')}%`;
    return [
        typedInputIds(sessionId, pattern),
        matchingAnswerIds(turnAnswerIds(sessionId), pattern),
        matchingAnswerIds(turnlessAnswerIds(sessionId), pattern),
    ];
}
function typedInputIds(sessionId, pattern) {
    const notSynthetic = SYNTHETIC_RESPONSE_MARKERS.map((marker) => sql `AND instr(${text('u')}, ${marker}) = 0`);
    return sql `SELECT u.id FROM ${messageRows} AS u
      INDEXED BY idx_local_runtime_message_rows_session_role_id
    WHERE u.session_id = ${sessionId} AND u.role = 'user'
      AND coalesce(u.source, ${field('u', '$.source')}, '') NOT IN ${INTERNAL_USER_SOURCES}
      AND coalesce(${field('u', '$.kind')}, 'steered_user') = 'steered_user'
      AND ${text('u')} LIKE ${pattern} ESCAPE '!'
      ${sql.join(notSynthetic, sql ` `)}`;
}
/** 挑中的回答行按主键读取，只匹配它们的文本。 */
function matchingAnswerIds(answerIds, pattern) {
    return sql `SELECT m.id FROM ${messageRows} AS m
    WHERE m.id IN (${answerIds}) AND ${text('m')} LIKE ${pattern} ESCAPE '!'`;
}
/** 有 assistant 行的每一轮，取其中最后一条有文本的 assistant 行。 */
function turnAnswerIds(sessionId) {
    return sql `SELECT (SELECT a.id FROM ${messageRows} AS a
        INDEXED BY idx_local_runtime_message_rows_turn_source
      WHERE a.session_id = ${sessionId} AND a.turn_id = t.turn_id AND a.role = 'assistant'
        AND ${answerText('a')}
      ORDER BY a.id DESC LIMIT 1)
    FROM ${messageRows} AS t INDEXED BY idx_local_runtime_message_rows_turn_source
    WHERE t.session_id = ${sessionId} AND t.turn_id IS NOT NULL AND t.role = 'assistant'
    GROUP BY t.turn_id`;
}
/**
 * 没有 turn id 的行：任何来源的 user 行和 Session 末尾都会结束一轮，
 * 每轮取前一条 user 行之后最后一条有文本的 assistant 行。
 */
function turnlessAnswerIds(sessionId) {
    return sql `SELECT (SELECT a.id FROM ${messageRows} AS a
        INDEXED BY idx_local_runtime_message_rows_turn_source
      WHERE a.session_id = ${sessionId} AND a.turn_id IS NULL AND a.role = 'assistant'
        AND a.id < b.hi
        AND a.id > coalesce((SELECT max(p.id) FROM ${messageRows} AS p
            INDEXED BY idx_local_runtime_message_rows_session_role_id
          WHERE p.session_id = ${sessionId} AND p.role = 'user' AND p.id < b.hi), 0)
        AND ${answerText('a')}
      ORDER BY a.id DESC LIMIT 1)
    FROM (SELECT u.id AS hi FROM ${messageRows} AS u
        INDEXED BY idx_local_runtime_message_rows_session_role_id
      WHERE u.session_id = ${sessionId} AND u.role = 'user'
      UNION ALL SELECT 9223372036854775807) AS b`;
}
/** 会显示文本的 assistant 行：没有标记卡片的 `kind`，内容也不只是空格、制表符和换行。 */
function answerText(row) {
    return sql `${field(row, '$.kind')} IS NULL
    AND length(trim(${text(row)}, char(32, 9, 10, 13))) > 0`;
}
/** 取行别名上 `data_json` 的一个字段，JSON 格式不对时返回 NULL，不报错。 */
function field(row, path) {
    return sql.raw(`CASE WHEN json_valid(${row}.data_json) THEN json_extract(${row}.data_json, '${path}') END`);
}
/** 行别名的显示文本：取 `msg_content`，没有就取 `msgContent`。 */
function text(row) {
    return sql.raw(`CASE WHEN json_valid(${row}.data_json) THEN coalesce(
    json_extract(${row}.data_json, '$.msg_content'), json_extract(${row}.data_json, '$.msgContent')
  ) END`);
}
/** `LIKE` 只把 ASCII 大写字母当成小写，其他字符按原样比较。 */
function foldAsciiCase(value) {
    return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}
//# sourceMappingURL=search-match.js.map