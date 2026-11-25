// metainfo module barrel — host-neutral surface shared by every Mavis
// host that delivers assets (cloud-harness-server deliver-assets rewrite).
//
// Typical import patterns:
//
//   import { injectByMimeType, newProducerAigcInfo } from '@mavis/agent-tools/cloud/metainfo';
//   import { signAigcProducer, fillSignatures } from '@mavis/agent-tools/cloud/metainfo';
//
// Internal modules (image.ts / audio.ts / video.ts) are re-exported
// for unit tests that want to bypass the MIME dispatcher.
export { injectByMimeType, normaliseMimeType, } from './inject.js';
export { DefaultContentActor, LabelAIGenerated, newProducerAigcInfo } from './default.js';
export { inferMetainfoMimeType } from './mime.js';
export { buildSignData, canonicalJsonStringify, fillSignatures, generateKeyPairHex, signAigcProducer, signAigcPropagator, verifyAigcProducer, verifyAigcPropagator, } from './sm2.js';
export { injectJpeg, injectPng } from './image.js';
export { injectAudio, addAigcToWav } from './audio.js';
export { injectVideo } from './video.js';
export { injectOoxml, isOoxmlMime } from './ooxml.js';
export { injectPdf, isPdfMime } from './pdf.js';
export { FFMPEG_TIMEOUT_MS } from './ffmpeg.js';
//# sourceMappingURL=index.js.map