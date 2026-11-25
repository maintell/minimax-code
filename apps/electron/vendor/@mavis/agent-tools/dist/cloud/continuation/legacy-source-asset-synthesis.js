/**
 * Legacy source-asset record synthesis — 存量 session 附件的分享兜底。
 *
 * 背景:sidecar(`continuation-source-assets.jsonl`)是分享功能新增结构,只在
 * 新路径的 turn 执行时写入。分享功能上线前的附件消息没有 record,导出时消息
 * 里的附件引用无法替换成 `asset://`:内联图片/视频的 base64 block 残留会被
 * 投影的 text-only 净化拒绝,文件路径则静默留成死路径。
 *
 * server 侧不缺任何东西——descriptor(`request.source_assets`)来自 server 的
 * 消息记录投影,资产字节冻结走 server OSS 原件 copy,对 legacy 附件天然工作。
 * 缺的只是 runtime 侧"该附件在消息里的哪个位置"这条事实。本模块在导出时刻
 * 从消息本身反推这条事实,现场合成 record(只在内存参与本次 manifest 构建,
 * **不写回 sidecar** —— sidecar 保持"turn 时刻记录"的语义纯净)。
 *
 * 反推策略(按 descriptor 的 kind):
 * - user_attachment + 内联媒体(图片/视频都以 `{type:'image', data:base64}`
 *   block 持久化):**内容寻址** —— 解每个 image block 的 base64 算 sha256,与
 *   descriptor.sha256(server 冻结原件的指纹)精确匹配。装载进消息的字节就是
 *   上传原件,匹配即证明归属,无需猜 ordinal。同字节多次出现时按序分配。
 * - user_attachment + 文件路径:在消息文本里找以 descriptor.file_name 结尾的
 *   路径 token 或附件清单的 path 属性,要求全消息**恰好出现一次**(与
 *   `replacePathInContent` 的替换标准一致,合成前先验,避免替换期才炸)。
 * - deliver_asset:按 source_ref_ordinal 在 assistant 文本的
 *   `<deliver-assets>` 块里提取第 N 个 `<media src>`(与
 *   `replaceDeliverOccurrence` 的 ordinal 语义一致)。
 *
 * 反推不出(找不到 / 有歧义)就放弃该 descriptor,不伪造:文件路径原文残留
 * (无害),残留的内联媒体 block 由投影层降级成占位文本 —— 单个附件失败绝不
 * 阻断整体导出。
 *
 * 合成 record 的 sha256/size_bytes/binding 一律取自 descriptor(server 原件
 * 为准):这让下游 `validateSourceIdentity` 天然通过,legacy 场景不引入任何
 * 校验豁免分支。
 */
import { createHash } from 'node:crypto';
import { SourceAssetRecordSchema } from './source-asset-record.js';
const SOURCE_ASSET_SCHEMA = 'mavis.continuation.source-asset.v1';
export function synthesizeLegacySourceAssetRecords(input) {
    const { sessionId, persisted, descriptors, existingRecords } = input;
    const recordedOccurrences = new Set(existingRecords.map(occurrenceKey));
    const messagesById = new Map();
    for (const message of persisted) {
        if (!messagesById.has(message.message_id))
            messagesById.set(message.message_id, message);
    }
    // 同一消息里多个相同字节的内联媒体:按序分配,已被占用的 content_index 不重用。
    const claimedContentIndexes = new Map();
    for (const record of existingRecords) {
        if (record.representation !== 'image_content' || record.content_index === null)
            continue;
        claim(claimedContentIndexes, record.history_message_id, record.content_index);
    }
    const synthesized = [];
    for (const descriptor of descriptors) {
        if (recordedOccurrences.has(occurrenceKey(descriptor)))
            continue;
        const envelope = messagesById.get(descriptor.source_message_id);
        // 消息不在本次导出的 basis 里(被压缩掉等):保持既有 display-only 语义。
        if (!envelope)
            continue;
        const candidate = descriptor.source_ref_kind === 'user_attachment'
            ? synthesizeUserAttachment(sessionId, envelope, descriptor, claimedContentIndexes)
            : synthesizeDeliverAsset(sessionId, envelope, descriptor);
        if (!candidate)
            continue;
        const parsed = SourceAssetRecordSchema.safeParse(candidate);
        if (!parsed.success)
            continue; // 反推产物不合法即放弃,fail open to占位
        synthesized.push(parsed.data);
        recordedOccurrences.add(occurrenceKey(parsed.data));
    }
    return synthesized;
}
function synthesizeUserAttachment(sessionId, envelope, descriptor, claimedContentIndexes) {
    const message = envelope.message;
    if (message.role !== 'user')
        return undefined;
    const base = {
        schema: SOURCE_ASSET_SCHEMA,
        session_id: sessionId,
        source_message_id: descriptor.source_message_id,
        history_message_id: envelope.message_id,
        source_ref_kind: 'user_attachment',
        source_ref_ordinal: descriptor.source_ref_ordinal,
        source_binding_id: null,
        sha256: descriptor.sha256,
        size_bytes: descriptor.size_bytes,
        file_name: descriptor.file_name,
        mime_type: descriptor.mime_type,
    };
    // ── 内联媒体:内容寻址(图片与视频同为 image block) ─────────────────────
    const contentIndex = findInlineMediaIndex(message.content, descriptor, claimedContentIndexes.get(envelope.message_id));
    if (contentIndex !== undefined) {
        claim(claimedContentIndexes, envelope.message_id, contentIndex);
        return {
            ...base,
            representation: 'image_content',
            // 合成 record 不落盘;附件清单里有这张图的路径就带上,导出时才能换成占位。
            // 没有清单的老消息只需一个可追溯的非空占位。
            sandbox_path: findUniqueAttachmentPath(message.content, descriptor.file_name) ??
                `legacy-inline://${descriptor.asset_id}`,
            content_index: contentIndex,
        };
    }
    // ── 文件:文本路径匹配(要求全消息恰好一次,与替换器同标准) ─────────────
    const path = findUniqueAttachmentPath(message.content, descriptor.file_name);
    if (path !== undefined) {
        return { ...base, representation: 'sandbox_path', sandbox_path: path, content_index: null };
    }
    return undefined;
}
/** 解每个 image block 的 base64,与 descriptor 的 sha256/size 精确匹配。 */
function findInlineMediaIndex(content, descriptor, claimed) {
    if (!Array.isArray(content))
        return undefined;
    for (let index = 0; index < content.length; index += 1) {
        if (claimed?.has(index))
            continue;
        const block = content[index];
        if (typeof block !== 'object' || block === null)
            continue;
        const item = block;
        if (item.type !== 'image' || typeof item.data !== 'string')
            continue;
        let bytes;
        try {
            bytes = Buffer.from(item.data, 'base64');
        }
        catch {
            continue;
        }
        if (bytes.length !== descriptor.size_bytes)
            continue;
        if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256)
            continue;
        return index;
    }
    return undefined;
}
/**
 * 在用户消息文本里找以 `/<file_name>` 或 `__<file_name>` 结尾的路径 token 或附件清单的 path 属性。
 * 全消息(跨 text block)恰好命中一个 token 且该 token 恰好出现一次才算数,
 * 与 `replacePathInContent` 的 exactly-once 替换约束对齐。
 */
function findUniqueAttachmentPath(content, fileName) {
    const texts = [];
    if (typeof content === 'string') {
        texts.push(content);
    }
    else if (Array.isArray(content)) {
        for (const block of content) {
            if (typeof block !== 'object' || block === null)
                continue;
            const item = block;
            if (item.type === 'text' && typeof item.text === 'string')
                texts.push(item.text);
        }
    }
    else {
        return undefined;
    }
    const matches = new Set();
    const addIfMatches = (candidate) => {
        if (!candidate.startsWith('/'))
            return;
        if (!candidate.endsWith(`/${fileName}`) && !candidate.endsWith(`__${fileName}`))
            return;
        matches.add(candidate);
    };
    for (const text of texts) {
        // 附件清单把路径写在 path 属性里,路径可能带空格,按属性整段取。
        for (const match of text.matchAll(/\bpath="([^"]+)"/gu))
            addIfMatches(match[1] ?? '');
        for (const token of text.split(/\s+/u)) {
            addIfMatches(token.replace(/[)\]}>,;:'"`]+$/u, '')); // 去掉贴尾标点
        }
    }
    if (matches.size !== 1)
        return undefined;
    const [path] = matches;
    if (!path)
        return undefined;
    let occurrences = 0;
    for (const text of texts)
        occurrences += text.split(path).length - 1;
    return occurrences === 1 ? path : undefined;
}
function synthesizeDeliverAsset(sessionId, envelope, descriptor) {
    const message = envelope.message;
    if (message.role !== 'assistant' || !Array.isArray(message.content))
        return undefined;
    let ordinalBase = 0;
    let source;
    for (const block of message.content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const item = block;
        if (item.type !== 'text' || typeof item.text !== 'string')
            continue;
        const result = extractDeliverOccurrenceSrc(item.text, descriptor.source_ref_ordinal - ordinalBase);
        ordinalBase += result.occurrenceCount;
        if (result.src === undefined)
            continue;
        if (source !== undefined)
            return undefined; // 跨 block 歧义,放弃
        source = result.src;
    }
    if (source === undefined || !source.startsWith('/') || source.startsWith('asset://')) {
        return undefined;
    }
    return {
        schema: SOURCE_ASSET_SCHEMA,
        session_id: sessionId,
        source_message_id: descriptor.source_message_id,
        history_message_id: envelope.message_id,
        source_ref_kind: 'deliver_asset',
        source_ref_ordinal: descriptor.source_ref_ordinal,
        source_binding_id: descriptor.source_binding_id,
        representation: 'deliver_asset',
        sandbox_path: source,
        content_index: null,
        sha256: descriptor.sha256,
        size_bytes: descriptor.size_bytes,
        file_name: descriptor.file_name,
        mime_type: descriptor.mime_type,
    };
}
/**
 * 从 assistant 文本提取 `<deliver-assets>` 块里第 targetOrdinal 个
 * `<media ... src="..."/>` 的 src。解析模式必须与 export-service 的
 * `replaceDeliverOccurrence` 保持一致(那边做替换,这边只提取),两处如有
 * 改动需同步。
 */
function extractDeliverOccurrenceSrc(text, targetOrdinal) {
    const blockPattern = /<deliver-assets\b[^>]*>([\s\S]*?)<\/deliver-assets>/giu;
    const mediaPattern = /<media\s+([^>]*?)\/>/giu;
    let occurrence = 0;
    let src;
    for (const blockMatch of text.matchAll(blockPattern)) {
        const block = blockMatch[0];
        for (const mediaMatch of block.matchAll(mediaPattern)) {
            const current = occurrence;
            occurrence += 1;
            if (current !== targetOrdinal)
                continue;
            const attributes = mediaMatch[1] ?? '';
            const sourceMatch = attributes.match(/\bsrc\s*=\s*"([^"]+)"/iu);
            if (sourceMatch?.[1] !== undefined && src === undefined)
                src = sourceMatch[1];
        }
    }
    return { src, occurrenceCount: occurrence };
}
function occurrenceKey(source) {
    return `${source.source_message_id}\0${source.source_ref_kind}\0${source.source_ref_ordinal}`;
}
function claim(map, messageId, index) {
    const set = map.get(messageId) ?? new Set();
    set.add(index);
    map.set(messageId, set);
}
//# sourceMappingURL=legacy-source-asset-synthesis.js.map