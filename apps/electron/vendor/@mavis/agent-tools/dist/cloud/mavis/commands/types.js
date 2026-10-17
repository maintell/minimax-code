/**
 * mavis tool 各 command handler 的共享类型 ——
 *   - `CommandContext`:dispatcher 装配,每个 handler 都可读
 *   - `CommandHandler<TArgs>`:handler 函数签名
 *
 * Handler 返 `DofldOutput`(success/failure 统一形态),抛 Error 由 dispatcher
 * top-level catch 兜底成 unknown failure。
 */
import { archonBusinessFailure, success } from '../output.js';
/**
 * 写类 RPC 共用收尾 —— `base_resp.status_code != 0` 走业务错误通道,否则原 resp
 * 当成功返回。每个 commands/*.ts 文件都用得到,集中在这里避免重复。
 *
 * resp 类型故意只约束 `base_resp` 字段;archon-rpc-types.ts 里 typed Resp 接口
 * 不带 index signature,所以这里**不**用 `& Record<string, unknown>`,否则
 * typed 接口对不上(TS 不会自动 widen 到 index signature)。
 */
export function baseRespOrSuccess(command, resp, path) {
    if (resp.base_resp && resp.base_resp.status_code !== 0) {
        return archonBusinessFailure(command, resp.base_resp, path);
    }
    return success(command, resp);
}
//# sourceMappingURL=types.js.map