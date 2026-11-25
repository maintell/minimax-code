/**
 * CloudSecretStore —— 用户 secret 的内存状态机。
 *
 *   - `bootstrap(secrets[])` —— 收到 archon-server 下发的全量 secrets 时调一次
 *     (cloud-runtime:`controlHarness` mode=START;cloud-harness-server:HarnessRun),
 *     清空 + 装入新值,rebuild masker。
 *   - `applyCreate / applyUpdate / applyDelete` —— agent 通过 secret_{create,
 *     update,delete} tool 调 archon-server CRUD 成功后就地热更新
 *     in-mem state,rebuild masker。DB 是事实源,RPC 失败 store 不动 — 不会
 *     "DB 跟内存分裂"。
 *
 * **scope** 由宿主决定:cloud-runtime 是进程级单例(一个进程只服务一个
 * user/biz,每个 turn 启动 `bootstrap` 全量覆盖);cloud-harness-server 每个
 * run 一个实例,随 run 释放,不跨 run / 租户共享。
 *
 * **明文不出本类**:外部只能拿到:
 *   - `getMasker()` —— 用来过 outbound RuntimeEvent
 *   - `get(name)` —— 内部读 secret 给 tool/model;不暴露 forEach / keys 之类
 *     批量遍历 API,避免明文意外泄露(secret_list 由 archon-server RPC 返
 *     SecretMeta,不靠 store)
 *
 * **rebuild 是幂等的**:每次 mutation 都 rebuild masker,并发 race
 * (虽然 cloud-runtime 单进程单 turn 不应该有真正并发)自动收敛。开销可接受
 * —— masker 池 ≤ 50 entries(per-(user,biz) 上限),rebuild O(n log n)。
 */
import { SecretMasker } from './secret-masker.js';
export class CloudSecretStore {
    values = new Map();
    masker = new SecretMasker(new Map());
    /**
     * 全量替换 —— 通常只在 turn START 收到 `HarnessControlReq.secrets[]` 时调一次。
     * 重复 bootstrap(同一 turn 多次 START 不太可能但也合法)是幂等的。
     */
    bootstrap(secrets) {
        this.values.clear();
        if (secrets && secrets.length > 0) {
            for (const s of secrets) {
                // wire 字段 required string,但防御性挡 undefined / 空 name 一下,
                // 不让损坏数据污染 masker 池。
                if (typeof s.name !== 'string' || s.name.length === 0)
                    continue;
                if (typeof s.value !== 'string')
                    continue;
                this.values.set(s.name, s.value);
            }
        }
        this.rebuildMasker();
    }
    /** Tool secret_create 成功后的就地热更新。 */
    applyCreate(name, value) {
        this.values.set(name, value);
        this.rebuildMasker();
    }
    /**
     * Tool secret_update 成功后的就地热更新。`newValue` undefined 表示只改了
     * description(value 没动) — store 不需要变,masker 也不重建。
     */
    applyUpdate(name, newValue) {
        if (newValue === undefined)
            return;
        if (this.values.get(name) === newValue)
            return;
        this.values.set(name, newValue);
        this.rebuildMasker();
    }
    /** Tool secret_delete 成功后的就地热更新。删不存在的 key 是 no-op。 */
    applyDelete(name) {
        if (this.values.delete(name)) {
            this.rebuildMasker();
        }
    }
    /** 单个 secret 读取 —— tool / model 路径主动取 value 时用。 */
    get(name) {
        return this.values.get(name);
    }
    /** 当前 secret name 列表 —— diagnostic(secret_list 不读这,走 RPC)。 */
    names() {
        return [...this.values.keys()];
    }
    /** 当前 masker —— 出方向 mask 流程读它替换 outbound 文本。 */
    getMasker() {
        return this.masker;
    }
    /** 当前 secret 数量 —— diagnostic / metrics。 */
    size() {
        return this.values.size;
    }
    rebuildMasker() {
        this.masker = new SecretMasker(this.values);
    }
}
//# sourceMappingURL=secret-store.js.map