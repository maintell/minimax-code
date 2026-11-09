import { validatePptPackageClosure } from "./package-closure";
import { createHash } from "node:crypto";
import jszip from "jszip";
import { SaxesParser } from "saxes";
import { PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
import { validatePptxWriteArchive } from "../pptx-notes-writer";
function sha(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** This seam is callable only with an application-owned CoreHost reply. */
export async function applyCorePptxPatch(original, input) {
    const plan = input;
    if (!plan ||
        plan.schema !== 'mavis.pptx_package_patch.v1' ||
        plan.baseSourceSha256 !== sha(original) ||
        !Number.isSafeInteger(plan.documentRevision) ||
        !Array.isArray(plan.replacements) ||
        plan.replacements.length > 1000 ||
        !Array.isArray(plan.expectedChangedParts) ||
        plan.expectedChangedParts.length !== plan.replacements.length)
        throw new Error('invalid_patch_plan');
    if (plan.replacements.length === 0)
        return original;
    await validatePptxWriteArchive(original);
    const seen = new Set();
    let total = 0;
    const zip = await jszip.loadAsync(original, { checkCRC32: true });
    for (const replacement of plan.replacements) {
        if (!replacement ||
            typeof replacement.partUri !== 'string' ||
            replacement.partUri.startsWith('/') ||
            /[\\?#\u0000]/u.test(replacement.partUri) ||
            replacement.partUri
                .split('/')
                .some((segment) => !segment || segment === '.' || segment === '..') ||
            seen.has(replacement.partUri) ||
            !plan.expectedChangedParts.includes(replacement.partUri) ||
            !(replacement.bytes instanceof Uint8Array) ||
            replacement.bytes.length > PPTX_PREVIEW_LIMITS_V1.maxEntryUncompressedBytes)
            throw new Error('invalid_patch_plan');
        seen.add(replacement.partUri);
        total += replacement.bytes.length;
        if (total > PPTX_PREVIEW_LIMITS_V1.maxTotalUncompressedBytes)
            throw new Error('resource_limit_exceeded');
        const entry = zip.file(replacement.partUri);
        if (replacement.expectedSha256 === null) {
            if (entry)
                throw new Error('source_mutated');
        }
        else {
            if (!entry || sha(await entry.async('uint8array')) !== replacement.expectedSha256)
                throw new Error('source_mutated');
        }
        if (replacement.partUri.endsWith('.xml') || replacement.partUri.endsWith('.rels')) {
            let count = 0;
            const parser = new SaxesParser({ xmlns: true });
            parser.on('doctype', () => {
                throw new Error('invalid_patch_plan');
            });
            parser.on('opentag', () => {
                if (++count > PPTX_PREVIEW_LIMITS_V1.maxPartXmlElements)
                    throw new Error('resource_limit_exceeded');
            });
            parser.write(new TextDecoder('utf-8', { fatal: true }).decode(replacement.bytes)).close();
        }
        zip.file(replacement.partUri, replacement.bytes, {
            ...(entry ? { date: entry.date } : {}),
            createFolders: false,
        });
    }
    await validatePptPackageClosure(zip);
    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await validatePptxWriteArchive(output);
    return output;
}
