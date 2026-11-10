import { createHash } from 'node:crypto';
import { ALL_FORMATS, BufferSource, BufferTarget, Conversion, Input, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, WebMOutputFormat, } from 'mediabunny';
const CONTAINER_BY_MIME = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/mkv': 'mkv',
    'video/webm': 'webm',
};
/**
 * History replays the same videos on every request of a session, so each
 * outcome is kept by the hash of the original base64. Bounded by the bytes of
 * stripped data held; least recently used entries go first.
 */
const STRIP_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const stripCache = new Map();
let stripCacheBytes = 0;
/**
 * Returns the request copy of `messages` with the audio track removed from
 * every video the target model receives, when the model cannot read audio.
 * Only the provider-bound copy changes: persisted history keeps the original
 * video, so a later audio-capable model still gets the soundtrack.
 */
export async function stripVideoAudioForModel(messages, model) {
    const unchanged = { messages: [...messages], strippedCount: 0, keptMimeTypes: {} };
    if (model.audioInput === true)
        return unchanged;
    let strippedCount = 0;
    const kept = new Map();
    const projected = [];
    for (const message of messages) {
        if (message.role === 'assistant' || !Array.isArray(message.content)) {
            projected.push(message);
            continue;
        }
        let changed = false;
        const content = [];
        for (const block of message.content) {
            const next = await stripBlock(block);
            if (next.outcome === 'stripped')
                strippedCount += 1;
            if (next.outcome === 'kept' && block.type === 'image') {
                kept.set(block.mimeType, (kept.get(block.mimeType) ?? 0) + 1);
            }
            changed ||= next.block !== block;
            content.push(next.block);
        }
        projected.push(changed ? { ...message, content } : message);
    }
    return { messages: projected, strippedCount, keptMimeTypes: Object.fromEntries(kept) };
}
async function stripBlock(block) {
    const image = block;
    if (image?.type !== 'image' || typeof image.mimeType !== 'string') {
        return { block, outcome: 'untouched' };
    }
    const mimeType = image.mimeType.toLowerCase();
    if (!mimeType.startsWith('video/') || typeof image.data !== 'string') {
        return { block, outcome: 'untouched' };
    }
    const container = CONTAINER_BY_MIME[mimeType];
    if (!container)
        return { block, outcome: 'kept' };
    const outcome = await cachedStrip(image.data, container);
    if (outcome.kind === 'stripped') {
        return { block: { ...block, data: outcome.data }, outcome: 'stripped' };
    }
    return { block, outcome: outcome.kind === 'failed' ? 'kept' : 'untouched' };
}
async function cachedStrip(data, container) {
    const key = createHash('sha256').update(data).digest('hex');
    const cached = stripCache.get(key);
    if (cached) {
        stripCache.delete(key);
        stripCache.set(key, cached);
        return cached;
    }
    const outcome = await removeAudioTrack(data, container);
    remember(key, outcome);
    return outcome;
}
function remember(key, outcome) {
    const size = outcome.kind === 'stripped' ? outcome.data.length : 0;
    if (size > STRIP_CACHE_MAX_BYTES)
        return;
    stripCache.set(key, outcome);
    stripCacheBytes += size;
    for (const [oldest, value] of stripCache) {
        if (stripCacheBytes <= STRIP_CACHE_MAX_BYTES)
            break;
        stripCache.delete(oldest);
        if (value.kind === 'stripped')
            stripCacheBytes -= value.data.length;
    }
}
/**
 * Remuxes the video without its audio tracks, copying the encoded video as is:
 * no frame is decoded or re-encoded, so it costs about one pass over the bytes.
 */
async function removeAudioTrack(data, container) {
    const input = new Input({
        source: new BufferSource(Buffer.from(data, 'base64')),
        formats: ALL_FORMATS,
    });
    try {
        if ((await input.getAudioTracks()).length === 0)
            return { kind: 'no-audio' };
        const output = new Output({ format: outputFormat(container), target: new BufferTarget() });
        pinCreationTime(output);
        const conversion = await Conversion.init({
            input,
            output,
            audio: { discard: true },
            // Never re-encode: a track that cannot be copied is discarded, which the
            // video check below turns into "send the original".
            copy: { mode: 'forced' },
            showWarnings: false,
        });
        const lostVideo = conversion.discardedTracks.some(({ track, reason }) => track.type === 'video' && reason !== 'discarded_by_user');
        if (!conversion.isValid || lostVideo)
            return { kind: 'failed' };
        await conversion.execute();
        const buffer = output.target.buffer;
        if (!buffer)
            return { kind: 'failed' };
        return { kind: 'stripped', data: Buffer.from(buffer).toString('base64') };
    }
    catch {
        return { kind: 'failed' };
    }
    finally {
        input.dispose();
    }
}
function outputFormat(container) {
    switch (container) {
        case 'mp4':
            return new Mp4OutputFormat();
        case 'mov':
            return new MovOutputFormat();
        case 'mkv':
            return new MkvOutputFormat();
        case 'webm':
            return new WebMOutputFormat();
    }
}
/**
 * The MP4/MOV muxer stamps the current time into the movie and track headers,
 * so the same video would remux to different bytes after a restart and miss
 * provider-side caches keyed by content. The muxer is built synchronously in
 * the Output constructor; pin its creation time to the format's epoch.
 */
function pinCreationTime(output) {
    const muxer = Reflect.get(output, '_muxer');
    if (muxer && typeof muxer.creationTime === 'number')
        muxer.creationTime = 0;
}
//# sourceMappingURL=video-audio-strip.js.map