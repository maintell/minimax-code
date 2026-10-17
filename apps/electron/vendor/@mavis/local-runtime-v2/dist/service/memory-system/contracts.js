/**
 * Memory V2 共享契约。
 *
 * 唯一事实源是 `.harness/docs/specs/memory-v2-design.md` 的 §2.2-§2.5、§5.2-§5.14、
 * §5.16、§5.17 与 §10；本文件是这些章节的逐条转写，不引入文档之外的语义。
 * 全部实现模块都只依赖本文件，任何契约调整必须先改设计文档再回写这里。
 *
 * 不包含 §5.15 MemoryApplication：它依赖 thrift-gen 生成的 Desktop 请求/响应类型，
 * IDL 不在本仓库，需另走 desktop-service-idl-first 跨仓流程。
 */
// ---------------------------------------------------------------------------
// 2.2 作用域
// ---------------------------------------------------------------------------
/**
 * 全局作用域的固定标识（§2.2）。本地桌面即单用户，记忆归用户而非某个 Agent 或 Project；
 * Agent、Project 名称与工作目录降级为记忆产物中的内容标注。
 * 保留 ScopeKey 类型与目录层级是为将来再分区留出位置。
 */
export const GLOBAL_SCOPE_KEY = 'global';
//# sourceMappingURL=contracts.js.map