export async function writeFileChunkFully(writer, chunk, invalidWrite) {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const remaining = chunk.byteLength - offset;
        const { bytesWritten } = await writer.write(chunk, offset, remaining, null);
        // 短写可以继续补齐；零进度和越界结果会导致死循环或数据损坏，必须立即失败。
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
            throw invalidWrite();
        }
        offset += bytesWritten;
    }
}
//# sourceMappingURL=file-chunk-writer.js.map