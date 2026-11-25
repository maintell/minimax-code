import { Type } from '@sinclair/typebox';
import { callerSessionId, invalidArgument, uiRequestTool } from './desktop-tool-factory.js';
/**
 * The `panel` tools: show something in the right-hand side panel, which is
 * the only surface that can display a workspace file or the review view.
 *
 * They change what the user sees and nothing else — no data is written and
 * repeating a call is harmless. The panel is shared by the whole window, so
 * the UI only acts when the calling conversation is the one on screen;
 * otherwise the tool reports `SESSION_NOT_ACTIVE` and never switches chats.
 */
export const PanelOpenFileToolDef = {
    name: 'panel_open_file',
    namespace: 'panel',
    description: "Show a file in the desktop app's right-hand panel, optionally scrolled to a line. Pass a " +
        'directory to open the file tree at that folder instead. Only do this when the user asked to ' +
        'look at something.',
    schema: Type.Object({
        path: Type.String({
            minLength: 1,
            description: 'File or directory path, absolute or relative to the conversation workspace.',
        }),
        line: Type.Optional(Type.Integer({ minimum: 1, description: 'Line to scroll to; 1-based.' })),
        line_end: Type.Optional(Type.Integer({ minimum: 1, description: 'Last line of the range to select.' })),
    }),
};
export const PanelOpenReviewToolDef = {
    name: 'panel_open_review',
    namespace: 'panel',
    description: "Show the workspace's Git changes in the desktop app's right-hand panel, optionally focused on " +
        'one file and line. Needs Coding mode and a project folder that is a Git repository; otherwise ' +
        'it fails and the panel stays as it is. Only do this when the user asked to review or see the diff.',
    schema: Type.Object({
        path: Type.Optional(Type.String({
            minLength: 1,
            description: 'Changed file to focus, relative to the workspace.',
        })),
        line: Type.Optional(Type.Integer({
            minimum: 1,
            description: 'Line in the new version of the file to scroll to; 1-based. Needs path.',
        })),
    }),
};
export function buildLocalPanelTools(adapter) {
    return [
        uiRequestTool(PanelOpenFileToolDef, adapter, (input, ctx) => ({
            sessionId: callerSessionId(ctx),
            operation: 'panel.open_file',
            target: {
                path: input.path,
                ...(input.line !== undefined ? { line: input.line } : {}),
                ...(input.line_end !== undefined ? { lineEnd: input.line_end } : {}),
            },
        })),
        uiRequestTool(PanelOpenReviewToolDef, adapter, (input, ctx) => {
            // A line is a position inside a changed file; without the file the review
            // view has nothing to scroll, so this never reaches the panel.
            if (input.line !== undefined && input.path === undefined) {
                throw invalidArgument('line needs path: name the changed file the line is in.');
            }
            return {
                sessionId: callerSessionId(ctx),
                operation: 'panel.open_review',
                target: {
                    ...(input.path !== undefined ? { path: input.path } : {}),
                    ...(input.line !== undefined ? { line: input.line } : {}),
                },
            };
        }),
    ];
}
//# sourceMappingURL=local-panel-tools.js.map