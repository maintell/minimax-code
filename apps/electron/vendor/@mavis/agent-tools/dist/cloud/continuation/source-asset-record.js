import { z } from 'zod';
const SOURCE_ASSET_SCHEMA = 'mavis.continuation.source-asset.v1';
const SafeIdSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._:-]+$/u);
export const SourceAssetRecordSchema = z
    .object({
    schema: z.literal(SOURCE_ASSET_SCHEMA),
    session_id: SafeIdSchema,
    source_message_id: SafeIdSchema,
    history_message_id: SafeIdSchema,
    source_ref_kind: z.enum(['user_attachment', 'deliver_asset']),
    source_ref_ordinal: z.number().int().nonnegative(),
    source_binding_id: SafeIdSchema.nullable(),
    representation: z.enum(['sandbox_path', 'image_content', 'deliver_asset']),
    sandbox_path: z.string().min(1),
    content_index: z.number().int().nonnegative().nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    size_bytes: z.number().int().nonnegative(),
    file_name: z.string().min(1).max(512),
    mime_type: z.string().min(1).max(256),
})
    .strict()
    .superRefine((value, ctx) => {
    if (value.source_ref_kind === 'deliver_asset' && !value.source_binding_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'deliver asset requires binding id' });
    }
    if (value.source_ref_kind === 'deliver_asset' && value.representation !== 'deliver_asset') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'deliver source requires deliver representation',
        });
    }
    if (value.source_ref_kind === 'user_attachment' && value.source_binding_id !== null) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'user attachment cannot have binding id',
        });
    }
    if (value.source_ref_kind === 'user_attachment' && value.representation === 'deliver_asset') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'user attachment cannot use deliver representation',
        });
    }
    if (value.representation === 'image_content' && value.content_index === null) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'image content requires content index',
        });
    }
});
export class SourceAssetSidecarConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SourceAssetSidecarConflictError';
    }
}
export function parseSourceAssetRecords(body, key, sessionId) {
    const records = [];
    for (const [index, raw] of body.toString('utf8').split('\n').entries()) {
        if (!raw.trim())
            continue;
        let value;
        try {
            value = JSON.parse(raw);
        }
        catch (error) {
            throw new Error(`source asset sidecar ${key} line ${index + 1} is invalid JSON`, {
                cause: error,
            });
        }
        const parsed = SourceAssetRecordSchema.safeParse(value);
        if (!parsed.success || parsed.data.session_id !== sessionId) {
            throw new Error(`source asset sidecar ${key} line ${index + 1} is invalid`);
        }
        if (findSourceAssetRecord(records, parsed.data)) {
            throw new Error(`source asset sidecar ${key} line ${index + 1} is a duplicate occurrence`);
        }
        records.push(parsed.data);
    }
    return records;
}
export function findSourceAssetRecord(records, candidate) {
    for (const record of records) {
        if (record.source_message_id !== candidate.source_message_id ||
            record.source_ref_kind !== candidate.source_ref_kind ||
            record.source_ref_ordinal !== candidate.source_ref_ordinal) {
            continue;
        }
        if (JSON.stringify(record) === JSON.stringify(candidate))
            return true;
        throw new SourceAssetSidecarConflictError('source asset occurrence already has different metadata');
    }
    return false;
}
//# sourceMappingURL=source-asset-record.js.map