import path from 'node:path';
import { gitRoot } from '../../service/workspace/index.js';
/**
 * Read the row per Invocation to reflect model switches, but cache repository roots per workspace
 * to avoid repeating the git process.
 */
export function createPluginExtensionSessionFacts(deps) {
    const roots = new Map();
    const readRoot = deps.gitRoot ?? gitRoot;
    return async (sessionId) => {
        const row = await deps.repository.get(sessionId);
        if (!row)
            throw new Error(`session ${sessionId} is missing`);
        const model = await deps.sessionModel(sessionId);
        if (!model)
            throw new Error(`session ${sessionId} has no model`);
        let root = roots.get(row.workspaceDir);
        if (!root) {
            root = readBoundedRoot(readRoot, row.workspaceDir);
            roots.set(row.workspaceDir, root);
        }
        const resolvedRoot = await root;
        return {
            cwd: row.workspaceDir,
            ...(resolvedRoot === undefined ? {} : { root: resolvedRoot }),
            model,
        };
    };
}
async function readBoundedRoot(readRoot, workspace) {
    let timer;
    try {
        const root = await Promise.race([
            readRoot(workspace),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(undefined), 5_000);
            }),
        ]);
        return root ? path.normalize(root) : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=plugin-extension-session-facts.js.map