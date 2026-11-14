import { resolveSessionLocalAsset } from '../../infra/file/assets-store.js';
import { isSearchIndexedSession } from '../session-system/index.js';
/** A bare asset ID as the store names it; never a path. */
const ASSET_ID = /^asset_[A-Za-z0-9_-]+$/u;
/**
 * Bunny reads an attachment's original by its asset ID (spec 12.6, 15.5):
 * the ID the covered-range attachment line, the search hits and
 * `conversation_read` give. Before the permission gate sees the call, a
 * `read` whose path is exactly an asset ID of Bunny's current main
 * conversation is pointed at the stored file. Anything else, including an
 * asset of another session, is left as written.
 */
export function createBunnyAssetReadExtension(input) {
    return {
        id: 'bunny-asset-read',
        init(pi) {
            pi.on('before_tool_call', async (event, _signal, ctx) => {
                const path = readPathArgument(event.toolCall.name, event.args);
                if (!path || !isSearchIndexedSession(input.db, ctx.sessionId))
                    return undefined;
                const asset = await resolveSessionLocalAsset({
                    dataDir: input.dataDir,
                    sessionId: ctx.sessionId,
                    assetId: path,
                });
                if (asset)
                    event.args['path'] = asset.absolutePath;
                return undefined;
            });
        },
    };
}
function readPathArgument(toolName, args) {
    if (toolName !== 'read' || !args || typeof args !== 'object' || Array.isArray(args))
        return undefined;
    const path = Reflect.get(args, 'path');
    return typeof path === 'string' && ASSET_ID.test(path.trim()) ? path.trim() : undefined;
}
//# sourceMappingURL=asset-read.js.map