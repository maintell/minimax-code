import { formatAssetReference, isLegacyAssetNodeId, isSpaceLinkMime, } from '@mavis/shared/drive-assets';
/**
 * Whether a Drive node id names a native asset library item. A legacy `cs_`
 * item is an ordinary attachment and never becomes an asset reference.
 */
export function isNativeAssetNodeId(nodeId) {
    const id = nodeId?.trim();
    return id !== undefined && id.length > 0 && !isLegacyAssetNodeId(id);
}
/**
 * Asset reference line printed first inside an `<attachment>` taken from the
 * asset library (Drive); `undefined` for an attachment without a native Drive
 * node. The asset has no local copy: the agent downloads it by node id.
 */
function buildAttachmentAssetReference(input) {
    const nodeId = input.driveNodeId?.trim();
    if (!nodeId || !isNativeAssetNodeId(nodeId))
        return undefined;
    return formatAssetReference({
        nodeId,
        ...(input.drivePath ? { path: input.drivePath } : {}),
        type: input.type,
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    });
}
const SPACE_REFERENCE_INSTRUCTION = {
    folder: 'This Space folder has no local copy. Use its node_id to list it or download items from Space into the workspace when its contents are needed.',
    link: 'This Space link has no content. Run space_stat with its node_id and read the `link` field for its URL; do not download it.',
    file: 'This Space file has no local copy. Use its node_id to download it from Space into the workspace when its contents are needed.',
};
/**
 * Body of a reference-only Space `<attachment>`: its reference line and what the agent should do
 * with it. A link is a file node marked by its MIME: it has no content (so no size), only a url.
 */
export function buildSpaceReferenceAttachmentBody(input) {
    let type = input.image ? 'image' : 'file';
    if (input.folder)
        type = 'folder';
    else if (isSpaceLinkMime(input.mimeType))
        type = 'link';
    const reference = buildAttachmentAssetReference({
        driveNodeId: input.driveNodeId,
        drivePath: input.drivePath,
        type,
        // formatAssetReference drops the size for folders and links.
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    });
    return {
        folder: type === 'folder',
        lines: [
            ...(reference ? [reference] : []),
            SPACE_REFERENCE_INSTRUCTION[type === 'image' ? 'file' : type],
        ],
    };
}
export function buildUserProfileBlock(content, guidance) {
    return [
        '<user_profile>',
        'What you know about the user so far:',
        '',
        content,
        '',
        '---',
        guidance,
        '</user_profile>',
    ].join('\n');
}
/** Shared skeleton of the summary, tail and topics blocks: tag, Host intro, blank line, body. */
export function buildMemoryBlock(tag, wording, body) {
    return [`<${tag}${wording.attributes ?? ''}>`, wording.intro, '', body, `</${tag}>`].join('\n');
}
export function buildMemoryNoteBlock(note) {
    return ['<agent_memory_note>', note, '</agent_memory_note>'].join('\n');
}
export function buildAvailableMemoryTopicsBlock(topics, wording) {
    const entries = topics.flatMap((topic) => [
        '  <topic>',
        `    name: ${escapeXml(topic.name)}`,
        `    desc: ${escapeXml(topic.description)}`,
        `    ${topic.detail}`,
        '  </topic>',
    ]);
    return buildMemoryBlock('available_memory_topics', wording, entries.join('\n'));
}
export function buildDailyMemoryBlock(content) {
    return [
        '<daily_digest>',
        'Recent daily summaries — what happened in the past few days.',
        '',
        content,
        '</daily_digest>',
    ].join('\n');
}
function escapeXml(value) {
    return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
//# sourceMappingURL=prompt-blocks.js.map