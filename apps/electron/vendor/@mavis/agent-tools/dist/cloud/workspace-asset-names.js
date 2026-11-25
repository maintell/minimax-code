/**
 * harness 写入 workspace 的资产命名规则：continuation 资产文件名、插件包缓存目录名。
 * v1 cloud-runtime 与 v2 cloud-harness-server 共用，保证两边落盘路径一致。
 */
import { basename } from 'node:path';
const PLUGIN_CONTENT_DIGEST_PATTERN = /^sha256-tree-v1:([0-9a-f]{64})$/u;
/** `<asset_id>__<安全化的文件名>`；文件名只保留 `[A-Za-z0-9._-]`，最长 200 字符，空时为 `asset.bin`。 */
export function continuationAssetFileName(asset) {
    const safeName = basename(asset.file_name)
        .replace(/[^A-Za-z0-9._-]/gu, '_')
        .slice(-200);
    return `${asset.asset_id}__${safeName || 'asset.bin'}`;
}
/** `sha256-tree-v1:<hex>` → `sha256-tree-v1-<hex>`；格式不符时为 undefined。 */
export function pluginPackageCacheKey(contentDigest) {
    const match = PLUGIN_CONTENT_DIGEST_PATTERN.exec(contentDigest);
    return match ? `sha256-tree-v1-${match[1]}` : undefined;
}
//# sourceMappingURL=workspace-asset-names.js.map