/**
 * SecretMasker —— 出方向脱敏的实际替换引擎。
 *
 * 输入:一组 `name → value` 映射(明文 secret 来自 turn-scoped SecretStore)。
 * 输出:把任意文本里出现的 value 字面量替换成 `{{ARCHON_SECRET:NAME}}` 占位符。
 *
 * 算法(对齐 secrets-plan-v0.3 § 9):
 *   1. **过滤短值**:`value.length < 8` 不入 needle 池 —— 阻止"普通文字撞短
 *      value"的误伤(例如 `value="ok"` 会把所有英文 "ok" 都替换掉)。
 *   2. **longest-first**:按 value 字符串长度倒序排,先匹配长 needle,避免短
 *      value 抢先匹配长 value 的前缀。比如 secret `A="abcdef"` + `B="abc"`,
 *      要先替换 `abcdef` 再替换 `abc`,否则 `abcdef` 会先被切成 `{{B}}def`。
 *   3. **双形态 needle**:raw 字符串 + JSON-escaped 形式都加进 needle 池。
 *      JSON-escaped 处理常见 LLM tool_use payload 把 secret 包在 JSON string
 *      里时的反斜线场景(例如 value 含换行 `\n` → JSON 里是字面 `\\n`)。
 *      两种形态都映射到同一个占位符。
 *   4. **替换**:`String.replaceAll(value, placeholder)`。一次 `apply` 调用
 *      会按 needle 顺序串行替换,确保 longest-first 顺序生效。
 *
 * 边界(写进产品文档):防的是 LLM **意外回显** 用户给的 value 字面量;
 *   - 不防 LLM 主动变形(base64 / hex / 中间插空格 / 拆字)
 *   - 不防 LLM 把 secret 拼到不该出现的地方(只看出方向消息边界)
 *   - 短值(< 8 char)不入池 —— 用户体感:GitHub OAuth token / OpenAI sk-...
 *     这种远超 8 char,正常 secret 都能盖;真有短到 7 char 的 secret 也几乎
 *     一定撞普通文字
 *
 * 实现注意:
 *   - `apply` / `applyJson` 接受 `string | undefined` —— 大量调用方拿到的就是
 *     可选字段,内联 ?: 三目检查比每个调用点判一次干净
 *   - empty Map → `apply` 直接 short-circuit 返原值,零 needle 也零开销
 *   - rebuild 是幂等的,SecretStore 每次 patch 后无脑全量重建
 */
const PLACEHOLDER = (name) => `{{ARCHON_SECRET:${name}}}`;
/** 长度门槛 —— `value.length < 8` 不入 needle 池。 */
const MIN_SECRET_VALUE_LENGTH = 8;
export class SecretMasker {
    needles;
    constructor(values) {
        const acc = [];
        for (const [name, value] of values) {
            if (value.length < MIN_SECRET_VALUE_LENGTH)
                continue;
            const placeholder = PLACEHOLDER(name);
            acc.push({ literal: value, placeholder });
            // JSON-escaped 形式:把 value 当 JSON string 序列化再去掉外层引号,
            // 拿到的就是 LLM 把 value 嵌入 JSON 时实际呈现的转义形式。如果跟 raw
            // 一致(value 不含需转义的字符)则不重复添加。
            const jsonEscaped = JSON.stringify(value).slice(1, -1);
            if (jsonEscaped !== value) {
                acc.push({ literal: jsonEscaped, placeholder });
            }
        }
        // longest-first(literal.length 倒序)+ 去重 literal,避免同一字面量重复替换
        // 浪费。Set dedup 保留先出现的 placeholder —— 同 value 多 name 的边界场景下
        // 取 Map 迭代第一次命中的 name 即可,反正占位符都会还原成 value。
        const seen = new Set();
        const dedup = [];
        for (const n of acc) {
            if (seen.has(n.literal))
                continue;
            seen.add(n.literal);
            dedup.push(n);
        }
        dedup.sort((a, b) => b.literal.length - a.literal.length);
        this.needles = dedup;
    }
    /** 当前 needle 池是否为空 —— caller 用来跳过整个 mask 流程节省开销。 */
    get isEmpty() {
        return this.needles.length === 0;
    }
    /**
     * 替换任意纯文本中的 value 字面量。`text` 可能 undefined(IDL 字段大多
     * optional),原样回写。
     */
    apply(text) {
        if (text === undefined || text.length === 0)
            return text;
        if (this.needles.length === 0)
            return text;
        let out = text;
        for (const n of this.needles) {
            if (out.includes(n.literal)) {
                out = out.split(n.literal).join(n.placeholder);
            }
        }
        return out;
    }
    /**
     * 替换 JSON 串(tool_call_args / tool_call_result_data 这种)。当前实现等同
     * `apply` —— JSON-escaped needle 已经在 constructor 阶段一起注入,所以同一条
     * 替换通路就能处理 raw + escaped 两种形态。保留独立方法名给调用方表达意图,
     * 未来需要走 JSON parse → walk 结构化替换时不破坏 caller 签名。
     */
    applyJson(text) {
        return this.apply(text);
    }
}
//# sourceMappingURL=secret-masker.js.map