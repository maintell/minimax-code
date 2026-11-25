/**
 * PTC 子调用的 bash 全文出口。
 *
 * compute 上执行的命令没有 pi 落在 harness 主机的完整输出文件（core-tools 以
 * `persistOutput: false` 创建 bash），所以 core bash 工具读不回全文，子调用拿到的是
 * 头尾预览。但 compute 的 exec 与托管前台读回本来就把最多 8 MiB 的完整输出交给了
 * harness，只是 pi 在内存里只留头尾。这里按工具调用上下文把它攒起来，交给 core bash
 * 工具在内存里拼回全文，走它已有的 `uncappedOutput` 出口；上限仍是
 * `PTC_CHILD_FULL_OUTPUT_MAX_BYTES`，由 core bash 工具判定。
 *
 * 只为 PTC 子调用攒：顶层 bash 不攒，桌面不经过这里，行为不变。不在 harness 主机写文件。
 */
import { Buffer } from 'node:buffer';
const captures = new WeakMap();
/** 与 agent-tools `isPtcChildCall` 同一判定：只有 run_code 子调用带 parentToolCallId。 */
export function isPtcChildContext(ctx) {
    return typeof ctx.parentToolCallId === 'string' && ctx.parentToolCallId.length > 0;
}
/**
 * 本次工具调用的 capture。同一个 ctx 对象在 createOperations、托管前台与
 * readFullOutput 之间共用，所以一次 execute 内的三条路径看到同一份攒到的输出。
 */
export function bashFullOutputCapture(ctx) {
    const existing = captures.get(ctx);
    if (existing)
        return existing;
    const capture = { chunks: [], outputTruncated: false };
    captures.set(ctx, capture);
    return capture;
}
/**
 * 攒到的完整输出；没有攒到任何 chunk 时返回 undefined，core bash 工具退回原有路径
 * （读 pi 的输出文件，再退回预览）。
 *
 * 读完即清：一次工具调用只读一次，读完把这份 capture 从表里删掉。同一个 ctx 对象被
 * 复用时，下一次调用从空 capture 开始，不会把上一次的输出带进来。
 */
export function readBashFullOutput(ctx) {
    const capture = captures.get(ctx);
    if (!capture)
        return undefined;
    captures.delete(ctx);
    if (capture.chunks.length === 0)
        return undefined;
    return Buffer.concat(capture.chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
/** 覆盖式写入完整输出；托管前台一次读回整段时用。 */
export function setBashFullOutput(ctx, output, outputTruncated) {
    const capture = bashFullOutputCapture(ctx);
    capture.chunks.length = 0;
    capture.chunks.push(Buffer.from(output, 'utf8'));
    capture.outputTruncated = outputTruncated;
}
//# sourceMappingURL=full-output.js.map