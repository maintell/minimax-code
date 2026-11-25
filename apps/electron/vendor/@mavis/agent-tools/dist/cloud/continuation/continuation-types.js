import { CONTINUATION_EXPORT_SCHEMA, CONTINUATION_MATERIALIZE_SCHEMA, SHARE_CONTINUATION_MANIFEST_SCHEMA, } from '@mavis/protocol';
import { z } from 'zod';
export const SUPPORTED_SHARE_SANITIZER_VERSION = 'share-sanitizer-v1';
export const ContinuationBoundaryPositionSchema = z.enum(['before_user', 'through_user']);
const SafeIdSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._:-]+$/u);
const PathSegmentIdSchema = SafeIdSchema.refine((value) => value !== '.' && value !== '..', {
    message: 'path segment id cannot be . or ..',
});
/**
 * Share ids are object-key path segments. Server Fork reuses share_id to carry
 * a base64url fork id, so `_` is accepted in addition to the safe id alphabet.
 */
const ShareIdSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_.:-]+$/u)
    .refine((value) => value !== '.' && value !== '..', {
    message: 'path segment id cannot be . or ..',
});
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const AssetSizeSchema = z.number().int().nonnegative();
const FileNameSchema = z.string().min(1).max(512);
const MimeTypeSchema = z.string().min(1).max(256);
const AssetMetadataSchema = z
    .object({
    asset_id: SafeIdSchema,
    sha256: Sha256Schema,
    size_bytes: AssetSizeSchema,
    file_name: FileNameSchema,
    mime_type: MimeTypeSchema,
})
    .strict();
const SourceAssetSchema = AssetMetadataSchema.extend({
    source_message_id: SafeIdSchema,
    source_ref_kind: z.enum(['user_attachment', 'deliver_asset']),
    source_ref_ordinal: z.number().int().nonnegative(),
    source_binding_id: SafeIdSchema.nullable(),
})
    .strict()
    .superRefine((value, ctx) => {
    if (value.source_ref_kind === 'user_attachment' && value.source_binding_id !== null) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'user attachment binding must be null',
        });
    }
    if (value.source_ref_kind === 'deliver_asset' && value.source_binding_id === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'deliver asset binding is required' });
    }
});
const MaterializeAssetBindingSchema = z
    .object({
    asset_id: SafeIdSchema,
    recipient_binding_id: SafeIdSchema,
    recipient_source_message_id: SafeIdSchema,
    source_ref_kind: z.enum(['user_attachment', 'deliver_asset']),
    source_ref_ordinal: z.number().int().nonnegative(),
    download_url: z.string().url().max(8_192),
    sha256: Sha256Schema,
    size_bytes: AssetSizeSchema,
})
    .strict();
const AssistantContextSchema = z
    .object({
    api: z.string().min(1).max(256),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(512),
    content_layout: z
        .array(z.discriminatedUnion('kind', [
        z
            .object({
            kind: z.literal('text'),
            text: z.string(),
            text_signature: z.string().min(1).optional(),
        })
            .strict(),
        z
            .object({
            kind: z.literal('thinking'),
            thinking: z.string(),
            thinking_signature: z.string().min(1).optional(),
            redacted: z.boolean().optional(),
        })
            .strict(),
        z.object({ kind: z.literal('tool_call'), tool_call_id: SafeIdSchema }).strict(),
    ]))
        .max(2_000),
})
    .strict();
/** Which product flow created a continuation: shared-link continue or session Fork. */
export const ContinuationOriginSchema = z.enum(['share', 'fork']);
export const ContinuationMaterializeRequestSchema = z
    .object({
    schema: z.literal(CONTINUATION_MATERIALIZE_SCHEMA),
    request_id: SafeIdSchema,
    session_id: PathSegmentIdSchema,
    materialization_id: PathSegmentIdSchema,
    share_id: ShareIdSchema,
    sanitizer_version: z.literal(SUPPORTED_SHARE_SANITIZER_VERSION),
    manifest: z
        .object({
        object_key: z.string().min(1).max(1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        size_bytes: z.number().int().positive(),
    })
        .strict(),
    asset_bindings: z.array(MaterializeAssetBindingSchema).max(10_000),
    /**
     * Server Fork sends `origin: 'fork'` plus the real source session id; share
     * continuation omits both. `share_id` stays the fork id carrier either way.
     */
    origin: ContinuationOriginSchema.optional(),
    source_session_id: PathSegmentIdSchema.optional(),
    /**
     * Source DB msg_id -> recipient DB msg_id assigned by Server when it copies
     * the display rows. Manifest messages whose source_message_id hits this map
     * keep the Server id as their canonical message_id, so inherited user
     * messages stay addressable as Fork / Rewind anchors. Unmapped messages get
     * runtime `msg-*` ids. Values must not use the runtime `msg-` namespace and
     * must be unique.
     */
    message_id_map: z.record(SafeIdSchema, SafeIdSchema).optional(),
})
    .strict()
    .superRefine((value, ctx) => {
    if (value.message_id_map !== undefined) {
        const seen = new Set();
        for (const [sourceId, targetId] of Object.entries(value.message_id_map)) {
            if (targetId.startsWith('msg-')) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['message_id_map', sourceId],
                    message: 'message_id_map value cannot use the runtime msg- prefix',
                });
            }
            if (seen.has(targetId)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['message_id_map', sourceId],
                    message: 'message_id_map values must be unique',
                });
            }
            seen.add(targetId);
        }
    }
    if (value.origin === 'fork' && value.source_session_id === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['source_session_id'],
            message: 'fork materialization requires source_session_id',
        });
    }
});
export const ContinuationBoundarySchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('entire_session') }).strict(),
    z
        .object({
        mode: z.literal('user_anchor'),
        user_message_id: SafeIdSchema,
        position: ContinuationBoundaryPositionSchema,
    })
        .strict(),
]);
export const ContinuationExportRequestSchema = z
    .object({
    schema: z.literal(CONTINUATION_EXPORT_SCHEMA),
    request_id: SafeIdSchema,
    session_id: PathSegmentIdSchema,
    share_id: ShareIdSchema,
    sanitizer_version: z.literal(SUPPORTED_SHARE_SANITIZER_VERSION),
    boundary: ContinuationBoundarySchema,
    source_assets: z.array(SourceAssetSchema).max(10_000),
    /**
     * Server Fork sends `origin: 'fork'`: the fork shares the source workspace,
     * so export keeps sandbox paths verbatim and skips source-asset sidecar
     * rewriting. Share continuation omits it.
     */
    origin: ContinuationOriginSchema.optional(),
})
    .strict();
const VisibleMessageSchema = z
    .object({
    kind: z.literal('visible_message'),
    source_message_id: SafeIdSchema,
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    timestamp_ms: z.number().int().nonnegative(),
    asset_refs: z.array(SafeIdSchema).max(10_000),
    assistant_context: AssistantContextSchema.optional(),
})
    .strict();
const PortableCustomContextSchema = z
    .object({
    kind: z.literal('portable_custom_context'),
    source_message_id: SafeIdSchema,
    custom_type: z.string().min(1).max(256),
    content: z.union([
        z.string(),
        z
            .array(z
            .object({
            type: z.literal('text'),
            text: z.string(),
            text_signature: z.string().min(1).optional(),
        })
            .strict())
            .min(1)
            .max(10_000),
    ]),
    display: z.boolean(),
    timestamp_ms: z.number().int().nonnegative(),
})
    .strict();
const ToolCallSchema = z
    .object({
    tool_call_id: SafeIdSchema,
    tool_name: z.string().min(1).max(256),
    arguments: z.record(z.unknown()),
    thought_signature: z.string().min(1).optional(),
})
    .strict();
const CompletedToolGroupSchema = z
    .object({
    kind: z.literal('completed_tool_group'),
    group_id: SafeIdSchema,
    assistant: z
        .object({
        source_message_id: SafeIdSchema,
        text: z.string(),
        asset_refs: z.array(SafeIdSchema).max(10_000),
        tool_calls: z.array(ToolCallSchema).min(1).max(1_000),
        assistant_context: AssistantContextSchema.optional(),
    })
        .strict(),
    executions: z
        .array(z.discriminatedUnion('message_type', [
        z
            .object({
            source_message_id: SafeIdSchema,
            message_type: z.literal('bashExecution'),
            tool_call_id: SafeIdSchema,
            status: z.enum(['completed', 'cancelled']),
            content_text: z.string(),
            asset_refs: z.array(SafeIdSchema).max(10_000),
            exit_code: z.number().int().optional(),
            truncated: z.boolean(),
        })
            .strict(),
        z
            .object({
            source_message_id: SafeIdSchema,
            message_type: z.literal('toolResult'),
            tool_call_id: SafeIdSchema,
            status: z.literal('completed'),
            content_text: z.string(),
            asset_refs: z.array(SafeIdSchema).max(10_000),
            is_error: z.boolean(),
        })
            .strict(),
    ]))
        .min(1)
        .max(2_000),
})
    .strict();
const CanonicalCompactionSummarySchema = z
    .object({
    kind: z.literal('canonical_compaction_summary'),
    source_message_id: SafeIdSchema,
    summary: z.string(),
    tokens_before: z.number().int().nonnegative(),
    timestamp_ms: z.number().int().nonnegative(),
})
    .strict();
const SourceHistoryCommonShape = {
    artifact_id: z.string().min(1),
    retained_end_exclusive: z.number().int().nonnegative(),
    resolved_boundary_message_id: z.string().min(1).nullable(),
    resolved_boundary_turn_id: z.string().min(1),
    execution_message_ids: z.array(z.string().min(1)),
    prefix_digest: Sha256Schema,
    settled: z.literal(true),
};
const SourceHistoryProvenanceSchema = z.discriminatedUnion('mode', [
    z
        .object({
        mode: z.literal('entire_session'),
        artifact_scope: z.literal('current_head'),
        ...SourceHistoryCommonShape,
    })
        .strict(),
    z
        .object({
        mode: z.literal('user_anchor'),
        artifact_scope: z.literal('reachable_ancestor'),
        user_message_id: SafeIdSchema,
        position: ContinuationBoundaryPositionSchema,
        effective_anchor_message_id: z.string().min(1),
        effective_anchor_role: z.string().min(1),
        effective_anchor_ordinal: z.number().int().nonnegative(),
        cut_policy: z.enum(['before_anchor', 'through_anchor']),
        ...SourceHistoryCommonShape,
    })
        .strict(),
]);
const ManifestAssetSchema = AssetMetadataSchema.extend({
    representation: z.enum(['sandbox_path', 'image_content', 'deliver_asset']),
}).strict();
export const ShareContinuationManifestSchema = z
    .object({
    schema: z.literal(SHARE_CONTINUATION_MANIFEST_SCHEMA),
    share_id: ShareIdSchema,
    sanitizer_version: z.literal(SUPPORTED_SHARE_SANITIZER_VERSION),
    source_cutoff_message_id: z.string().min(1).max(1_024),
    source_history: SourceHistoryProvenanceSchema,
    assets: z.array(ManifestAssetSchema).max(10_000),
    messages: z
        .array(z.discriminatedUnion('kind', [
        VisibleMessageSchema,
        PortableCustomContextSchema,
        CompletedToolGroupSchema,
        CanonicalCompactionSummarySchema,
    ]))
        .min(1)
        .max(10_000),
})
    .strict()
    .superRefine((manifest, ctx) => {
    if (manifest.source_history.mode === 'user_anchor' &&
        manifest.source_history.effective_anchor_role !== 'user') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'continuation source anchor must be a user message',
            path: ['source_history', 'effective_anchor_role'],
        });
    }
    if (manifest.source_history.mode === 'user_anchor') {
        const source = manifest.source_history;
        if (source.artifact_id !== `history-prefix:${source.prefix_digest}`) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'user-anchor provenance must use its logical history prefix id',
                path: ['source_history', 'artifact_id'],
            });
        }
        const effectiveIsRequested = source.effective_anchor_message_id === source.user_message_id;
        const valid = (source.position === 'before_user' &&
            source.cut_policy === 'before_anchor' &&
            effectiveIsRequested) ||
            (source.position === 'through_user' &&
                source.cut_policy === 'through_anchor' &&
                effectiveIsRequested);
        if (!valid) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'continuation source position does not match its physical cut',
                path: ['source_history', 'cut_policy'],
            });
        }
    }
    let summaryCount = 0;
    for (let index = 0; index < manifest.messages.length; index += 1) {
        const message = manifest.messages[index];
        if (message?.kind === 'visible_message' &&
            message.role === 'user' &&
            message.assistant_context !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'user message cannot carry assistant context',
                path: ['messages', index, 'assistant_context'],
            });
        }
        if (manifest.messages[index]?.kind !== 'canonical_compaction_summary')
            continue;
        summaryCount += 1;
        if (index !== 0 || summaryCount > 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'canonical compaction summary must appear at most once and only first',
                path: ['messages', index],
            });
        }
    }
});
//# sourceMappingURL=continuation-types.js.map