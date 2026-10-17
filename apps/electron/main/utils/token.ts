// 最大输出 token 数
export let MAX_TOKENS = 32000;
/**
 * 简单的 token 计数函数
 * 粗略估算：1 token ≈ 4 个字符（英文）
 *
 * @param text 输入文本
 * @returns token 数量估算值
 */
export function simpleTokenCount(text) {
    return text.length / 4;
}
/**
 * 按 token 数截断文本（保留头尾）
 * 基于字符/token 比例估算，在换行符处截断保持完整性
 *
 * @param text 输入文本
 * @param maxTokens 最大 token 数
 * @param tokenCounter token 计数函数
 * @param keepHeadTail 是否保留头尾（默认 true）
 * @returns 截断后的文本
 */
export function truncateTextByTokens(text, maxTokens, tokenCounter = simpleTokenCount, keepHeadTail = true) {
    // 计算总 token 数
    const totalTokens = tokenCounter(text);
    // 未超过限制，直接返回
    if (totalTokens <= maxTokens) {
        return text;
    }
    // 计算 token/字符 比例，用于近似估算
    const charCount = text.length;
    const ratio = totalTokens / charCount;
    if (keepHeadTail) {
        // 保留头尾模式：为前后各分配一半空间（留 5% 安全边界）
        const charsPerHalf = Math.floor((maxTokens / 2 / ratio) * 0.95);
        // 截断前半部分：找到最近的换行符
        let headPart = text.slice(0, charsPerHalf);
        const lastNewlineHead = headPart.lastIndexOf('\n');
        if (lastNewlineHead > 0) {
            headPart = headPart.slice(0, lastNewlineHead);
        }
        // 截断后半部分：找到最近的换行符
        let tailPart = text.slice(-charsPerHalf);
        const firstNewlineTail = tailPart.indexOf('\n');
        if (firstNewlineTail > 0) {
            tailPart = tailPart.slice(firstNewlineTail + 1);
        }
        // 组合结果
        const truncationNote = `\n\n... [truncated: ${totalTokens} tokens -> ~${maxTokens} tokens limit] ...\n\n`;
        return headPart + truncationNote + tailPart;
    }
    else {
        // 仅保留开头模式
        const targetChars = Math.floor((maxTokens / ratio) * 0.95);
        // 截断到最近的换行符，避免截断到字符中间
        let truncatedText = text.slice(0, targetChars);
        const lastNewline = truncatedText.lastIndexOf('\n');
        if (lastNewline > 0) {
            truncatedText = truncatedText.slice(0, lastNewline);
        }
        const truncationNote = `\n\n... [truncated: ${totalTokens} tokens -> ~${maxTokens} tokens limit] ...\n`;
        return truncatedText + truncationNote;
    }
}
/**
 * 截断文件路径列表（保留头尾文件）
 *
 * @param files 文件路径数组
 * @param maxTokens 最大 token 数
 * @returns 截断后的文件列表和截断状态
 */
export function truncateFileList(files, maxTokens) {
    // 将文件路径数组转为文本（每行一个路径）
    const filesText = files.join('\n');
    const totalTokens = simpleTokenCount(filesText);
    // 未超过限制，直接返回
    if (totalTokens <= maxTokens) {
        return { files, truncated: false, originalCount: files.length };
    }
    // 使用现有函数截断文本（保留头尾）
    const truncatedText = truncateTextByTokens(filesText, maxTokens, simpleTokenCount, true);
    // 从截断后的文本中提取文件路径
    const lines = truncatedText.split('\n');
    const truncatedFiles = [];
    for (const line of lines) {
        const trimmed = line.trim();
        // 跳过空行和截断标记
        if (!trimmed || trimmed.startsWith('...') || trimmed.includes('[truncated:')) {
            continue;
        }
        truncatedFiles.push(line);
    }
    return {
        files: truncatedFiles,
        truncated: true,
        originalCount: files.length,
    };
}
/**
 * 截断 Grep 搜索结果（分模式处理）
 *
 * @param result Grep 搜索结果
 * @param maxTokens 最大 token 数
 * @returns 截断后的结果
 */
export function truncateGrepResult(result, maxTokens) {
    // Content 模式：截断 matches 数组（只保留前 N 个）
    if (result.matches && result.matches.length > 0) {
        // 计算所有匹配内容的 token 数
        const matchesText = result.matches
            .map((m) => {
            let text = `${m.file}:${m.line}:${m.column} ${m.content}`;
            if (m.context_before)
                text = m.context_before.join('\n') + '\n' + text;
            if (m.context_after)
                text = text + '\n' + m.context_after.join('\n');
            return text;
        })
            .join('\n\n');
        const totalTokens = simpleTokenCount(matchesText);
        if (totalTokens > maxTokens) {
            // 计算平均每个匹配占用的 token 数
            const avgTokensPerMatch = totalTokens / result.matches.length;
            const maxMatches = Math.floor(maxTokens / avgTokensPerMatch);
            console.log(`[Token] Grep matches truncated: ${result.matches.length} -> ${maxMatches} matches`);
            return {
                ...result,
                matches: result.matches.slice(0, maxMatches),
                // total_matches 保持原始值
            };
        }
    }
    // Files 模式：截断文件列表（保留头尾）
    if (result.files && result.files.length > 0) {
        const filesText = result.files.join('\n');
        const totalTokens = simpleTokenCount(filesText);
        if (totalTokens > maxTokens) {
            const { files: truncatedFiles } = truncateFileList(result.files, maxTokens);
            console.log(`[Token] Grep files truncated: ${result.files.length} -> ${truncatedFiles.length} files`);
            return {
                ...result,
                files: truncatedFiles,
            };
        }
    }
    // Count 模式：简单数量限制（通常不需要截断）
    if (result.counts && result.counts.length > 1000) {
        console.log(`[Token] Grep counts truncated: ${result.counts.length} -> 1000 entries`);
        return {
            ...result,
            counts: result.counts.slice(0, 1000),
        };
    }
    return result;
}
