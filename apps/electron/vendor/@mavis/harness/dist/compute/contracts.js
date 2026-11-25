/**
 * Compute 抽象：harness core 只看接口和 capabilities，不感知 compute 的具体形态。
 *
 * 设计 §5.4 的接口族逐字照抄；`ByteRange` / `ExecOptions` / `ExecResult` 设计正文只引用
 * 未定义，在本文件补齐（见各自注释）。按需下发（PendingIngress）只有云端需要，由
 * cloud-harness-server 的 run compute 闸门实现，不在 harness 契约内。
 *
 * 各形态的实现：
 *   local-machine（桌面 in-process）：fs = physical-fs；process = srt-macos 沙箱；transfer = 本机 HTTP 下载 / 上传
 *   cloud-sandbox：三组能力都走 SC 接口，链路 harness → AS /harness/compute/* → SC → pyworker → ComputePod
 *     fs       = SandboxControlFileSystem（SC 文件 RPC：StatFile / ReadFile / WriteFile / ListDir / ...）
 *     process  = SandboxControlProcess（exec = ExecShell；spawnBackground = ShellJob）
 *     transfer = SandboxControlTransfer（SC DownloadFiles / UploadFiles）
 *     envd 是 SC 的内部实现，不出现在任何接口中
 *   桌面 remote：fs / process / transfer = Compute Bridge 客户端（反向 WSS）
 */
export {};
//# sourceMappingURL=contracts.js.map