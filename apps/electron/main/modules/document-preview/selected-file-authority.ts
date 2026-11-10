import { randomBytes } from "node:crypto";
import { issueSelectedFileCapability } from "./workspace-authority";
const MAX_PER_SENDER = 64;
const TTL_MS = 30 * 60 * 1000;
const states = new WeakMap();
function stateFor(sender) {
    const existing = states.get(sender);
    if (existing)
        return existing;
    const state = { generation: 0, grants: new Map() };
    states.set(sender, state);
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) {
            state.generation++;
            state.grants.clear();
        }
    });
    sender.once('destroyed', () => {
        state.generation++;
        state.grants.clear();
    });
    return state;
}
/** Capture before showing a native dialog, so navigation during selection cannot transfer it. */
export function captureSelectedFileIssuer(sender) {
    const state = stateFor(sender);
    const generation = state.generation;
    return (paths) => {
        const result = Object.create(null);
        if (sender.isDestroyed() || state.generation !== generation)
            return result;
        const now = Date.now();
        for (const [token, grant] of state.grants) {
            if (grant.expiresAt <= now)
                state.grants.delete(token);
        }
        for (const filePath of paths.slice(0, MAX_PER_SENDER)) {
            // This capability is intentionally limited to the local PPTX preview surface.
            if (!/\.pptx$/iu.test(filePath))
                continue;
            const capability = issueSelectedFileCapability(filePath);
            if (!capability)
                continue;
            while (state.grants.size >= MAX_PER_SENDER) {
                state.grants.delete(state.grants.keys().next().value);
            }
            const token = randomBytes(24).toString('base64url');
            state.grants.set(token, { capability, expiresAt: now + TTL_MS });
            result[filePath] = token;
        }
        return result;
    };
}
/** Opaque renderer claim resolves only inside the originating WebContents lifetime. */
export function resolveSelectedFile(sender, token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(token) || sender.isDestroyed())
        return null;
    const state = states.get(sender);
    const grant = state?.grants.get(token);
    if (!grant)
        return null;
    if (grant.expiresAt <= Date.now()) {
        state.grants.delete(token);
        return null;
    }
    return grant.capability;
}
