import { readFile } from 'node:fs/promises';
import { selectMultimodalAttachments, } from '@mavis/agent-tools';
/** Concrete local media IO kept outside the AgentHost orchestration core. */
export async function prepareLocalInlineMedia(candidates, capabilities) {
    const selected = selectMultimodalAttachments(candidates, capabilities);
    const materialized = await Promise.all(selected.kept.map(async ({ candidate, mime }) => {
        const data = await readInlineMediaData(candidate);
        return data
            ? {
                key: candidate.key,
                attachment: { type: 'image', data, mimeType: mime },
            }
            : undefined;
    }));
    const available = materialized.filter((item) => item !== undefined);
    return {
        attachments: available.map(({ attachment }) => attachment),
        items: available,
        inlinedKeys: new Set(available.map(({ key }) => key)),
    };
}
async function readInlineMediaData(candidate) {
    if (candidate.data)
        return candidate.data;
    try {
        return (await readFile(candidate.filePath)).toString('base64');
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=inline-media.js.map