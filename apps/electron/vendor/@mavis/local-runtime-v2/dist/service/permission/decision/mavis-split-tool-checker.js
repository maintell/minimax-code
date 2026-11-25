import { MAVIS_BACKED_TOOL_NAMES } from '@mavis/agent-tools/namespaced-tools';
/**
 * Permission semantics the tools split out of the composite `mavis` declare for
 * themselves: every rule still decides them, and they carry no filesystem path
 * capability.
 *
 * Before the split each of these commands reached the engine as `mavis` with
 * `{ command, args }`. The engine's unknown-tool path scan reads top-level
 * fields (`filePath`, `file_path`, `path`, `output`, `destination`,
 * `target`, `dir`, `cwd`, and a space-free `command` that looks like a local
 * path or a script), and `mavis`'s own `command` was always a multi-word command
 * such as `mcp create`, so no intent was ever extracted and the call fell
 * through to "no checker registered, allowing by default".
 *
 * Flattening the arguments would otherwise hand `mcp_server_create` and
 * `mcp_server_update` a top-level `command` holding a stdio executable, and one
 * outside the workspace would start asking for an approval it never asked for.
 * Registering this checker keeps the decision exactly where it was.
 *
 * The result is an explicit allow rather than a passthrough: the reducer only
 * default-allows when no checker is registered at all, so a passthrough would
 * turn every rule-less call into an ask. Returning allow lands after the
 * reducer's deny, ask, content-ask and allow rule steps, so all of them still
 * decide first — the engine's own order is what keeps the rules authoritative.
 *
 * The tool list is the split tools themselves rather than a name match inside
 * the engine's general scan, so bash, the filesystem tools and third-party MCP
 * tools keep their path checks untouched.
 */
class MavisSplitToolPermissionChecker {
    checkPermissions(toolName) {
        return {
            behavior: 'allow',
            reason: {
                type: 'safetyCheck',
                description: `Tool "${toolName}" declares no path capability; rules decide it.`,
            },
        };
    }
}
/** Registers the declared semantics for the tools split out of `mavis`. */
export function registerMavisSplitToolCheckers(engine) {
    const checker = new MavisSplitToolPermissionChecker();
    for (const toolName of MAVIS_BACKED_TOOL_NAMES) {
        engine.registerToolPermissionChecker(toolName, checker);
    }
}
//# sourceMappingURL=mavis-split-tool-checker.js.map