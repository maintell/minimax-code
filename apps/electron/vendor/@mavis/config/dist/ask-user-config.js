export const ASK_USER_CONFIG_DEFAULTS = {
    enabled: true,
    defaultPolicy: 'auto',
    // Goal 是无人值守的自主执行，同步提问会让整个 Goal 停下等用户回来，所以目标模式默认不等回答：
    // 问题留在对话里，Agent 按推荐项继续，答案之后作为新消息送达。需要等待的用户可在设置页把
    // 目标模式改为「阻塞」或「自动」；已在 config.yaml 写了 `goalPolicy` 的保持原值。
    goalPolicy: 'skip',
    // 计划模式下的提问是在和用户讨论、锁定方案，下一步依赖回答，所以默认等回答；
    // 不想等的用户可在设置页把计划模式改为「跳过」或「自动」。
    planPolicy: 'block',
};
/**
 * 非法值逐项回落到默认值，而不是整体丢弃：用户手改 config.yaml 写错一个策略时，
 * 其余设置（包括 `enabled`）仍按用户意图生效。
 */
export function parseAskUserConfig(raw, defaults = ASK_USER_CONFIG_DEFAULTS) {
    const rawAskUser = raw.askUser;
    if (rawAskUser == null || typeof rawAskUser !== 'object' || Array.isArray(rawAskUser)) {
        return { ...defaults };
    }
    const obj = rawAskUser;
    return {
        enabled: typeof obj.enabled === 'boolean' ? obj.enabled : defaults.enabled,
        defaultPolicy: readPolicy(obj, 'defaultPolicy', isAskUserPolicy, defaults.defaultPolicy),
        goalPolicy: readPolicy(obj, 'goalPolicy', isAskUserContextPolicy, defaults.goalPolicy),
        planPolicy: readPolicy(obj, 'planPolicy', isAskUserContextPolicy, defaults.planPolicy),
    };
}
function readPolicy(obj, key, isValid, fallback) {
    const value = obj[key];
    if (isValid(value))
        return value;
    // 缺省是正常情况，不打日志；只有“写了但不合法”才提示，便于用户发现手改写错。
    if (value !== undefined)
        warnInvalidAskUserPolicy(key, fallback);
    return fallback;
}
/**
 * config 包没有 pino 实例，沿用 `asr.ts` 的做法直接写一行 pino 兼容的 JSON 到
 * stderr。不回显原值，避免把 config.yaml 里的任意内容带进日志。
 */
function warnInvalidAskUserPolicy(key, fallback) {
    const line = JSON.stringify({
        level: 40,
        time: Date.now(),
        name: 'config.askUser',
        msg: `Ignoring invalid askUser.${key} in config.yaml; using "${fallback}".`,
        reason: 'ask_user_policy_invalid',
        field: `askUser.${key}`,
        fallback,
    });
    process.stderr.write(`${line}\n`);
}
export function isAskUserPolicy(value) {
    return value === 'auto' || value === 'block' || value === 'skip';
}
export function isAskUserContextPolicy(value) {
    return value === 'follow' || isAskUserPolicy(value);
}
/**
 * 按场景取生效策略：plan 取 `planPolicy`，goal 取 `goalPolicy`；选 `follow`
 * 或场景为 ordinary 时取 `defaultPolicy`。
 *
 * 入参可能来自未经 `parseAskUserConfig` 归一化的对象（例如宿主直接透传的
 * raw 配置），所以这里对非法值再兜底一次：场景值非法按 `follow` 处理，
 * 默认值非法按 `auto` 处理，保证永远返回三种生效策略之一。
 */
export function resolveEffectiveAskUserPolicy(config, context) {
    const contextual = context === 'plan' ? config.planPolicy : context === 'goal' ? config.goalPolicy : 'follow';
    if (isAskUserPolicy(contextual))
        return contextual;
    return isAskUserPolicy(config.defaultPolicy)
        ? config.defaultPolicy
        : ASK_USER_CONFIG_DEFAULTS.defaultPolicy;
}
/**
 * 把生效策略和模型传入的 `async` 映射成实际执行模式：
 * block → sync，skip → async，auto 时只有 `async === true` 才是 async。
 * 未传或非布尔一律按 sync，兼容历史上普通问卷一律等待的行为。
 */
export function resolveAskUserResponseMode(policy, requestedAsync) {
    if (policy === 'block')
        return 'sync';
    if (policy === 'skip')
        return 'async';
    return requestedAsync === true ? 'async' : 'sync';
}
/**
 * Turn 开始（SR）和工具调用（问卷）两处都用这一个函数把 Plan / Goal 事实归成
 * 场景，避免两处优先级不一致。Goal 与 Plan 按产品约定互斥；万一同时为真，
 * 以 Plan 为准，因为 Plan 期间的 ask_user 本来就只服务于计划讨论。
 */
export function resolveAskUserPolicyContext(input) {
    if (input.planActive)
        return 'plan';
    if (input.goalActive)
        return 'goal';
    return 'ordinary';
}
//# sourceMappingURL=ask-user-config.js.map