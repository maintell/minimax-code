/**
 * Memory V2 正式版全量上线的一次性处理（memory-v2-design.md「全量上线」）。
 *
 * 1. 最低档账号一次性关闭记忆：升级后 Runtime 第一次就绪时判断一次，结果写入共享 KV，之后不再判断。
 *    M Plan Go 与旧 Token Plan Starter（档位名或 combo ID 310001 / 311001）把生成和使用都写成关闭；其余档位、记忆已全关、
 *    未登录或读不到会员信息时只记录结果，不改配置。只有写配置失败时不记录，下次启动再判断一次。
 *    协调轮次先等这次判断结束，再按当时的配置执行。
 * 2. 静默完成启用引导，替代 Desktop 的切换弹窗。是否需要引导沿用 `MemoryOnboarding.inspect` 的判定：
 *    没有完成记录，全局作用域没有 V2 内容，也没有执行过 Reset。需要时先确定记忆模型（没配过记忆模型且
 *    默认模型是 MiniMax 托管模型时写入 M3.1 Flash、低推理强度；BYOK 默认模型保持跟随），再 Reset，之前
 *    创建的会话不再提取，记忆只从之后的新会话生成；最后按“迁移旧记忆”完成引导，由 Reconciler 在后台迁移旧文件。
 */
import { logger } from '@mavis/shared/local-runtime-logging';
import { MANAGED_MINIMAX_PROVIDER_ID } from '../model-system/index.js';
import { insertPreferenceValueIfAbsent, readPreferenceValue, } from '../../infra/db/preference-values.js';
const PLAN_DEFAULTS_KEY = 'memoryV2.planDefaults';
/**
 * 静默引导已开始的标记，在 Reset 之前写入。作用域已执行过 Reset 时，靠它区分 Reset 是静默引导自己做的
 * （中断在写完成记录之前，下一轮补完），还是升级前就有的（沿用原判定，不做静默引导）。
 */
const SILENT_ONBOARDING_KEY = 'memoryV2.silentOnboarding';
/** 本次切换的用户没配过记忆模型、默认模型是 MiniMax 托管模型时改用的记忆模型；BYOK 默认模型保持跟随。 */
const ROLLOUT_MEMORY_MODEL = {
    modelName: `${MANAGED_MINIMAX_PROVIDER_ID}/MiniMax-M3.1-Flash`,
    reasoningEffort: 'low',
};
/**
 * 旧 Token Plan Starter 的开放平台 combo ID：月包、年包。会员接口的档位字段可能只给 combo ID，
 * 以 `token_plan_combo_id` 为准；取值与开放平台按档位限流的映射一致（coding_plan_tier.go）。
 */
const LEGACY_STARTER_COMBO_IDS = new Set(['310001', '311001']);
const isLowestTier = {
    mplan: (label) => label === 'go',
    token_plan: (label) => label.startsWith('starter'),
    // 缺少订阅类型的旧响应只能按档位名判断：Go 只属于 M Plan，Starter 只属于旧 Token Plan。
    unspecified: (label) => label === 'go' || label.startsWith('starter'),
};
/** @internal Exported only for focused tests. */
export function classifyMemoryPlan(plan) {
    if (plan.status !== 'known')
        return 'unknown';
    const family = planFamily(plan);
    if (family === 'unknown' || family === 'other')
        return family;
    if (family !== 'mplan' && isLegacyStarterCombo(plan.comboId))
        return 'lowest';
    const label = normalizeTierLabel(plan.tier);
    if (!label)
        return 'unknown';
    return isLowestTier[family](label) ? 'lowest' : 'other';
}
function planFamily(plan) {
    const type = plan.subscriptionType?.trim().toLowerCase() || undefined;
    if (type === 'unknown')
        return 'unknown';
    if (type === 'mplan' || type === 'token_plan')
        return type;
    if (type !== undefined)
        return 'other';
    if (plan.hasTokenPlan === true)
        return 'unspecified';
    return plan.hasTokenPlan === false ? 'other' : 'unknown';
}
function isLegacyStarterCombo(comboId) {
    return comboId !== undefined && LEGACY_STARTER_COMBO_IDS.has(comboId.trim());
}
/** 去掉套餐名前后缀与分隔符；纯数字是 SKU 编号，不能当作档位名。 */
function normalizeTierLabel(tier) {
    const label = tier
        ?.toLowerCase()
        .replace(/token\s*plan|m\s*plan|plan/gu, '')
        .replace(/[\s_-]+/gu, '');
    return label && !/^\d+$/u.test(label) ? label : undefined;
}
const OUTCOME_BY_TIER = { lowest: 'disabled', other: 'kept', unknown: 'unknown' };
export class MemoryRolloutGate {
    deps;
    planDefaults;
    constructor(deps) {
        this.deps = deps;
    }
    /** 每轮协调开始时调用：等档位判断结束；生成开启时先静默完成启用引导。 */
    async beforeRound() {
        await this.settlePlanDefaults();
        if (this.deps.config().writeEnabled)
            await this.completeOnboardingSilently();
    }
    /** 每个进程最多判断一次，并发调用共享同一次；不会抛错。 */
    settlePlanDefaults() {
        this.planDefaults ??= this.settle();
        return this.planDefaults;
    }
    async settle() {
        try {
            if (readPreferenceValue(this.deps.db, PLAN_DEFAULTS_KEY) !== undefined)
                return;
            const config = this.deps.config();
            if (!config.writeEnabled && !config.recallEnabled) {
                this.record({ outcome: 'already-off' });
                return;
            }
            const { readPlan, disableMemory } = this.deps;
            const plan = readPlan && disableMemory
                ? await readPlanOnce(readPlan)
                : { status: 'unknown', reason: 'plan-reader-unavailable' };
            const tier = classifyMemoryPlan(plan);
            if (tier === 'lowest' && disableMemory)
                await disableMemory();
            this.record({ outcome: OUTCOME_BY_TIER[tier], ...planFacts(plan) });
        }
        catch (error) {
            // 只有写配置或写记录失败会到这里：不留记录，下次启动再判断一次。
            this.deps.event?.('rollout.plan-defaults-failed', {});
            logger.warn({ error: String(error) }, '[memory-v2] plan defaults failed');
        }
    }
    record(record) {
        const value = { settledAtMs: this.deps.nowMs(), ...record };
        insertPreferenceValueIfAbsent(this.deps.db, PLAN_DEFAULTS_KEY, value);
        this.deps.event?.('rollout.plan-defaults', value);
        logger.info(value, '[memory-v2] plan defaults settled');
    }
    /**
     * 不需要引导时不做任何事。需要时先写开始标记，再 Reset，最后写完成记录。中途中断后，下一轮按标记继续：
     * 作用域还没 Reset 时重做 Reset；已经 Reset（或已有内容）时跳过 Reset，只补写完成记录。
     */
    async completeOnboardingSilently() {
        const { record, needsOnboarding } = await this.deps.onboarding.inspect();
        if (record)
            return;
        const resumed = readPreferenceValue(this.deps.db, SILENT_ONBOARDING_KEY) !== undefined;
        if (!needsOnboarding && !resumed)
            return;
        if (!resumed) {
            insertPreferenceValueIfAbsent(this.deps.db, SILENT_ONBOARDING_KEY, {
                startedAtMs: this.deps.nowMs(),
            });
        }
        // 先定记忆模型，随后的迁移与抽取都用它；写不进去时沿用默认模型，不影响引导。
        await this.pinRolloutMemoryModel();
        if (needsOnboarding)
            await this.deps.resetGlobalScope();
        const result = await this.deps.completeOnboarding({
            legacyChoice: 'migrate',
            backfillChoice: 'reset',
        });
        this.deps.event?.('rollout.onboarding-completed', { status: result.status, resumed });
        logger.info({ status: result.status, resumed }, '[memory-v2] onboarding completed silently');
    }
    async pinRolloutMemoryModel() {
        const { setMemoryModel, defaultModelName } = this.deps;
        if (!setMemoryModel || !defaultModelName)
            return;
        const config = this.deps.config();
        if (config.consolidationModel !== undefined || config.captureModel !== undefined)
            return;
        if (!defaultModelName().startsWith(`${MANAGED_MINIMAX_PROVIDER_ID}/`))
            return;
        try {
            await setMemoryModel(ROLLOUT_MEMORY_MODEL);
        }
        catch (error) {
            // 记忆模型是可选项：没写进去时抽取、整理与迁移回退到默认模型，Reset 与完成记录照常进行。
            // 引导完成后不再重试，这位用户的记忆继续跟随默认模型。
            this.deps.event?.('rollout.memory-model-failed', {});
            logger.warn({ error: String(error) }, '[memory-v2] rollout memory model not set');
            return;
        }
        logger.info({ ...ROLLOUT_MEMORY_MODEL }, '[memory-v2] rollout memory model set');
    }
}
async function readPlanOnce(readPlan) {
    try {
        return await readPlan();
    }
    catch {
        return { status: 'unknown', reason: 'plan-request-failed' };
    }
}
function planFacts(plan) {
    if (plan.status !== 'known')
        return { reason: plan.reason };
    return {
        ...(plan.subscriptionType ? { subscriptionType: plan.subscriptionType } : {}),
        ...(plan.tier ? { tier: plan.tier } : {}),
        ...(plan.comboId ? { comboId: plan.comboId } : {}),
    };
}
//# sourceMappingURL=rollout.js.map