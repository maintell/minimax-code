import { EXTENSION_DIAGNOSTICS, isExtensionErrorCode } from '../sdk/diagnostics.js';
/**
 * `fix` for host-side codes outside the SDK table (three.md §2.2 format: every
 * diagnostic the agent sees carries an actionable fix).
 */
const HOST_FIXES = {
    thrown: 'The hook threw: fix the error named in `message`, then run `extension test` or `extension preview` again.',
    timeout: 'Synchronous code ran past the time limit: remove busy loops and long synchronous work from the hook.',
    aborted: 'The hook was aborted; await `ctx` calls inside the hook instead of leaving them detached.',
    EXTENSION_HOOK_EXPIRED: 'The hook ran past its 10 s own-time budget: fetch less per render, cache results in `ctx.state`, or move slow work to a callback.',
    EXTENSION_RENDER_DEADLINE: 'The render missed its 30 s deadline: avoid awaiting slow MCP calls in render, or render a placeholder and refresh with `ctx.ui.invalidate()`.',
    EXTENSION_HANDLE_FORGED: 'Only return callbacks created by this module, or handles that came back from `next(e)`.',
    EXTENSION_HANDLE_STALE: 'The element was re-rendered before the gesture arrived. A late gesture reaches the new drawing only when the control or an ancestor has a `key` naming exactly one control: key list rows and controls whose callback redraws, or find the element again in the latest tree and retry.',
    EXTENSION_HOOK_FAILED: 'The callback threw or timed out: fix the error named in `message` and run the test again.',
    EXTENSION_WORKER_CRASHED: 'The extension worker restarted: look for unbounded loops or memory growth in the hooks.',
    EXTENSION_REQUEST_INVALID: 'Check the failure named in `message`: verify session facts are available, or check the site, handle, slot, key and matcher fields.',
    EXTENSION_SERVICE_FAILED: 'A host service rejected the call: check the arguments of the `ctx` call named in `message`.',
    TREE_INVALID: 'Return only catalog elements with token props; the renderer falls back on invalid subtrees.',
};
/** Fix text for any code the host or validator reports; `undefined` for console lines. */
export function fixFor(code) {
    if (isExtensionErrorCode(code))
        return EXTENSION_DIAGNOSTICS[code].fix;
    return HOST_FIXES[code];
}
//# sourceMappingURL=fixes.js.map