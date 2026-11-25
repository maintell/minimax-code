/**
 * 在 compute 内跑 ripgrep：argv 逐个 shell-quote 拼成命令字符串交给 `process.exec`，
 * 不在 harness 主机上 spawn rg（cloud-sandbox 的文件只存在于 ComputePod）。
 */
import { shellQuote } from '@mavis/agent-tools/shell-quote';
/** rg 在 compute 内的默认超时，对齐 v1 云端 sandbox-rg-runner。 */
export const RG_TIMEOUT_MS = 30_000;
export function rgCommand(args) {
    return ['rg', ...args].map(shellQuote).join(' ');
}
//# sourceMappingURL=rg-command.js.map