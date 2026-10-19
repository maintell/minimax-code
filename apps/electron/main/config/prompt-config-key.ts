import { readFileSync } from "node:fs";
import path from "node:path";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KEY_BYTES = 32;
const KEY_CARRIERS = [
    { relativePath: 'public/assets/img/breakDown.png', chunkType: 'maKs' },
    { relativePath: 'public/assets/img/computer_use.png', chunkType: 'mbKs' },
];
/** Reads the Desktop-only key from packaged PNGs or the unpackaged build helper. */
export function resolveDesktopPromptConfigKey(options) {
    if (!options.packaged) {
        const key = options.loadDevelopmentKey?.() ?? loadDevelopmentBuildKey(options.appPath);
        return copyValidatedKey(key);
    }
    const readFile = options.readFile ?? readFileSync;
    const shares = KEY_CARRIERS.map((carrier) => extractPrivatePngChunk(readFile(path.join(options.appPath, carrier.relativePath)), carrier.chunkType));
    try {
        const key = xorBuffers(shares);
        try {
            return Uint8Array.from(key);
        }
        finally {
            key.fill(0);
        }
    }
    finally {
        for (const share of shares)
            share.fill(0);
    }
}
function loadDevelopmentBuildKey(appPath) {
    const helperPath = path.join(appPath, 'scripts', 'prompt-config-key-package.cjs');
    const helper = require(helperPath);
    return helper.resolveBuildPromptConfigKey();
}
function copyValidatedKey(value) {
    if (value.length !== KEY_BYTES) {
        throw new Error('Desktop Prompt config key must be 32 bytes');
    }
    return Uint8Array.from(value);
}
function extractPrivatePngChunk(png, chunkType) {
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('Desktop Prompt config key carrier is not a PNG file');
    }
    let offset = PNG_SIGNATURE.length;
    let payload;
    while (offset < png.length) {
        if (offset + 12 > png.length)
            throw new Error('Desktop Prompt config key PNG is truncated');
        const length = png.readUInt32BE(offset);
        const dataOffset = offset + 8;
        const dataEnd = dataOffset + length;
        const end = dataEnd + 4;
        if (end > png.length)
            throw new Error('Desktop Prompt config key PNG chunk is truncated');
        const type = png.toString('ascii', offset + 4, offset + 8);
        if (type === chunkType) {
            if (payload)
                throw new Error(`Duplicate Desktop Prompt config key PNG chunk: ${chunkType}`);
            const expectedCrc = png.readUInt32BE(dataEnd);
            const actualCrc = crc32(png.subarray(offset + 4, dataEnd));
            if (expectedCrc !== actualCrc) {
                throw new Error(`Invalid Desktop Prompt config key PNG chunk CRC: ${chunkType}`);
            }
            payload = Buffer.from(png.subarray(dataOffset, dataEnd));
        }
        offset = end;
        if (type === 'IEND')
            break;
    }
    if (payload?.length !== KEY_BYTES) {
        throw new Error(`Desktop Prompt config key PNG share is missing: ${chunkType}`);
    }
    return payload;
}
function xorBuffers(buffers) {
    if (buffers.length !== KEY_CARRIERS.length) {
        throw new Error('Desktop Prompt config key requires two PNG shares');
    }
    const key = Buffer.alloc(KEY_BYTES);
    for (const buffer of buffers) {
        if (buffer.length !== KEY_BYTES) {
            throw new Error('Desktop Prompt config key share must be 32 bytes');
        }
        for (let index = 0; index < KEY_BYTES; index += 1)
            key[index] ^= buffer[index];
    }
    return key;
}
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}
