/**
 * Bash command secret-env collection —— `CloudBashTool` 在把命令转发给
 * archon-server `executeShell` 之前,从 turn-scoped SecretStore 收集要注入的
 * 环境变量。
 *
 * 背景:`ExecuteShellReq` 现已新增 `env_vars` map 字段(IDL field 5),
 * archon-server 把它透传到 sandbox-control `ExecShellRequest.env_vars`,
 * 再到 e2b SDK `sbx.commands.run(envs=...)`。所以 cloud-runtime 不再把
 * secret 拼成 `export` 前缀内联进 command,而是直接交给 `env_vars` 透传 ——
 * value 不再出现在 command wire 上,沙箱内 shell 仍能用 `${SECRET_NAME}`
 * 展开。`command` 保持原样转发。
 *
 * 设计要点:
 *   - **不再做 shell 转义**:value 走结构化 map 字段,不进 command line,
 *     POSIX 单引号转义那套坑(`$` / `` ` `` / `\` 二次解析)直接消失。
 *   - **空 store short-circuit**:返 `undefined`,调用方据此不带 `env_vars`
 *     字段(空 map 与不传等价,但省一个 wire 字段)。
 *   - **名字白名单**:严格匹配 `^[A-Z][A-Z0-9_]{0,63}$`(跟 SecretStore /
 *     server-side 校验同套),被破坏的 entry(理论不可能,但 defense-in-depth)
 *     直接跳过不入 map。
 */
const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * 从 secretStore 收集 `env_vars` map(name → value)。
 * Store 为空 / 缺失 / 全部 entry 不合法 → 返 `undefined`。
 *
 * 返回的 map 直接作为 `ExecuteShellRequest.env_vars` 透传给 archon-server,
 * 由其叠加到 Apollo env_template snapshot 之上(同名 key caller 覆盖),
 * 最终落到 e2b `sbx.commands.run(envs=...)`。
 */
export function collectSecretEnvVars(secretStore) {
    if (!secretStore || secretStore.size() === 0)
        return undefined;
    const names = secretStore.names().filter((n) => SECRET_NAME_REGEX.test(n));
    if (names.length === 0)
        return undefined;
    const envVars = {};
    for (const name of names) {
        const value = secretStore.get(name);
        // 理论不可能 —— size > 0 + name in names() 之间没有外部 mutation 路径,
        // 但 defense-in-depth 防 race / 测试 stub 怪行为,跳过 undefined 不抛。
        if (value === undefined)
            continue;
        envVars[name] = value;
    }
    return Object.keys(envVars).length > 0 ? envVars : undefined;
}
//# sourceMappingURL=secret-env-inject.js.map