import { defineRuntimeTool, } from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';
export function createPptPreviewExtension(port, options) {
    const tool = defineRuntimeTool({
        name: 'ppt_preview',
        source: 'builtin',
        schema: Type.Object({ request: Type.Object({}, { additionalProperties: true }) }, { additionalProperties: false }),
        description: 'Internal PPT document lifecycle for Desktop. Whenever creating or modifying a PPT, read the plugin Skill ppt:ppt-preview first and follow its protocol. Use this tool automatically regardless of generation plugin or library, without requiring the user to request a preview. Call capabilities then start BEFORE environment checks, materials, or writing files; publish complete cumulative PPTX snapshots as pages are made; complete binds the original final PPTX. Each call wraps the action in request: {schema: "minimax.ppt-preview.<action>.v1", action, ...}. capabilities needs only schema/action. For start use a unique requestId, artifactKey, title, aspectRatio and optional expectedPages. Use returned artifactId, generationId and acceptedRevision. For publish supply requestId, artifactId, generationId, baseRevision, pptx (workspace file path) and pages (all slides, each with stable pageId, one-based sourceSlide, title and contentState draft or ready). Advance baseRevision from acceptedRevision. status takes artifactId; use queryRequestId to resolve uncertain writes. After final QA publish all pages ready, then complete with requestId, artifactId, generationId, latest snapshotId, expectedRevision and original final pptx path whose bytes match that snapshot. Poll status until generation.state is completed. Reuse requestId only with identical parameters and bytes. For a later edit start with artifactId and previousGenerationId instead of artifactKey. Session identity is supplied by the host. Do not narrate this mechanism, Skill, protocol, snapshots, IDs, revisions, hashes, connection files, polling, or backpressure in user-facing prose. Report only content/design progress. The host owns the single document card and delivers the bound final file: after verified completion, finish with a concise content summary without another artifact tag or file link. Do not deliver intermediate files. Continue normal PPT delivery if unavailable or no final file is bound.',
        execute: async (context, input, signal) => {
            try {
                if (signal?.aborted)
                    throw new Error('PPT preview request canceled');
                const result = await port.execute(context.sessionId, input.request, {
                    turnId: context.turnId,
                    assistantMessageId: context.assistantMessageId,
                    toolCallId: context.toolCallId,
                });
                const action = input.request.action;
                const response = result;
                const delivered = response?.artifact?.generation?.state === 'completed' &&
                    Boolean(response.artifact.generation.finalFile);
                const guidance = delivered
                    ? '\nThe existing PPT card now provides the verified final file and its file actions. Finish with a concise content summary in the user language. Do not output another file path, Markdown link, or artifact tag for this PPT; the host has already delivered it.'
                    : action === 'start'
                        ? '\nThe host has created the clickable PPT card. Continue making the content. Do not describe the preview machinery or output an intermediate file link.'
                        : '';
                const text = JSON.stringify(result) + guidance;
                return {
                    tool_name: 'ppt_preview',
                    text,
                    content: [{ type: 'text', text }],
                    details: { result },
                };
            }
            catch (error) {
                const text = error instanceof Error
                    ? `${'code' in error ? `${String(error.code)}: ` : ''}${error.message}`
                    : String(error);
                return {
                    tool_name: 'ppt_preview',
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                };
            }
        },
    });
    return {
        id: 'ppt-preview',
        description: 'Generator-neutral PPT publication.',
        init(api) {
            api.registerTool((ctx) => (options.isAvailable(ctx) ? tool : null));
            api.contributeSystemPrompt((ctx) => options.isAvailable(ctx)
                ? 'When creating or editing a presentation, keep user-facing progress concise and in the user language: discuss content, visual design, and completed pages. Treat generation and preview implementation as internal work. Do not narrate reading Skills or references, element maps, compiler/lint/QA commands, page IDs, bounds checks, preview publication, snapshots, connections, revisions, or hashes unless the user explicitly asks about implementation. Explain a layout correction as a content/design adjustment, without raw technical errors. Once ppt_preview confirms a bound completed final file, the existing document card is the delivery: finish with a short content summary and do not repeat file paths, links, or artifact tags. If preview is unavailable or no final file is bound, use normal file delivery. Never fabricate generation progress or claim checks that were not performed.'
                : null);
        },
    };
}
//# sourceMappingURL=ppt-preview.js.map