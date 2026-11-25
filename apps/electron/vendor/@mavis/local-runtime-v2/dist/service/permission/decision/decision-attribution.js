/**
 * Explains a permission decision to logs and metrics without changing it:
 * structured-reason log fields, and which layer produced each verdict.
 */
import { emitFastAllowMetric, emitPermissionCheckMetric, } from '../approval/permission-metrics.js';
const REASON_CODES = {
    rule: 'persisted_rule',
    safetyCheck: 'safety_check',
    workingDirectory: 'working_directory_boundary',
    internalWhitelist: 'internal_whitelist',
    sessionOwnedReadablePath: 'session_owned_readable_path',
    trustedExactWrite: 'trusted_exact_write',
    tempDirectory: 'temp_directory',
    sandbox: 'sandbox',
    mode: 'permission_mode',
    pathValidation: 'path_validation',
    dangerousRemoval: 'dangerous_removal',
    subcommandResults: 'subcommand_results',
    rmRewrite: 'recoverable_delete_rewrite',
    recoverableDeleteRewrite: 'recoverable_delete_rewrite',
};
/**
 * Convert a structured decision reason into diagnostic fields. Bash
 * subcommands retain their command and safety detail so operators can explain
 * an allow/ask/deny without consulting messages.jsonl. A matched rule keeps its
 * content so the log names the exact rule. Filesystem reasons still omit the
 * tool's own paths and free-form descriptions.
 */
export function permissionReasonLogFields(reason, includeSafetyDetail = false) {
    const fields = { reason_code: REASON_CODES[reason.type] };
    if (reason.type === 'rule') {
        fields.rule_source = reason.rule.source;
        fields.rule_behavior = reason.rule.ruleBehavior;
        fields.rule_tool_name = reason.rule.ruleValue.toolName;
        if (reason.rule.ruleValue.ruleContent)
            fields.rule_content = reason.rule.ruleValue.ruleContent;
    }
    else if (reason.type === 'mode') {
        fields.reason_mode = reason.mode;
    }
    else if (reason.type === 'safetyCheck') {
        if (includeSafetyDetail)
            fields.reason_detail = reason.description;
        if (reason.category)
            fields.reason_category = reason.category;
    }
    else if (reason.type === 'subcommandResults') {
        fields.subcommand_results = [...reason.reasons].map(([command, result]) => ({
            command,
            behavior: result.behavior,
            reason_type: result.reason.type,
            ...permissionReasonLogFields(result.reason, true),
        }));
    }
    return fields;
}
/** Bash nests rule matches per subcommand; one that agrees with the verdict makes it a rule's. */
function decidedByRule({ reason, behavior }) {
    if (reason.type === 'rule')
        return true;
    if (reason.type !== 'subcommandResults')
        return false;
    return [...reason.reasons.values()].some((sub) => sub.behavior === behavior && sub.reason.type === 'rule');
}
export function engineDecisionSource(decision) {
    const origin = decidedByRule(decision) ? 'rule' : 'engine';
    return `${origin}_${decision.behavior}`;
}
/**
 * Allow-path safetyCheck categories and their snake_case metric labels;
 * anything else collapses to 'other' to bound the label.
 */
const FAST_ALLOW_CATEGORIES = new Map([
    ['authorizedLocalScript', 'authorized_local_script'],
    ['authorizedWriteRedirect', 'authorized_write_redirect'],
    ['authorizedPowerShellCopyMove', 'authorized_powershell_copy_move'],
    ['bypassAllow', 'bypass_allow'],
    ['helpFlagFastAllow', 'help_flag_fast_allow'],
    ['knownSafeCommand', 'known_safe_command'],
    ['knownSafePowerShellCommand', 'known_safe_powershell_command'],
    ['pureReadFastAllow', 'pure_read_fast_allow'],
    ['sourceLocalAllow', 'source_local_allow'],
    ['writeAuthorizedTarget', 'write_authorized_target'],
]);
/** Names the fast path behind an engine allow; subcommands that disagree report 'mixed'. */
export function fastAllowKind(reason) {
    if (reason.type === 'safetyCheck' && reason.category) {
        return FAST_ALLOW_CATEGORIES.get(reason.category) ?? 'other';
    }
    if (reason.type === 'subcommandResults' && reason.reasons.size > 0) {
        const [kind, ...others] = new Set([...reason.reasons.values()].map((sub) => fastAllowKind(sub.reason)));
        return kind && others.length === 0 ? kind : 'mixed';
    }
    return REASON_CODES[reason.type];
}
export const CLASSIFIER_SOURCES = {
    allow: 'classifier_allow',
    confirm: 'classifier_confirm',
    block: 'classifier_block',
    timeout: 'classifier_error',
};
/** Kept beside the verdict rather than on it, so the verdict shape never changes. */
const decisionTags = new WeakMap();
export function tagDecision(result, source, allowKind) {
    decisionTags.set(result, allowKind ? { source, allowKind } : { source });
    return result;
}
export function emitDecisionMetrics(metrics, input) {
    if (!metrics)
        return;
    const { toolName, mode, rawVerdict, finalVerdict } = input;
    const platform = input.platform ?? process.platform;
    const tag = decisionTags.get(rawVerdict);
    const source = rawVerdict.behavior === 'ask' && finalVerdict.behavior !== 'ask'
        ? 'ask_gate_bypass'
        : (tag?.source ?? 'unknown');
    emitPermissionCheckMetric(metrics, {
        mode,
        result: finalVerdict.behavior,
        source,
        toolName,
        platform,
    });
    if (source === 'engine_allow' && finalVerdict.behavior === 'allow' && tag?.allowKind) {
        emitFastAllowMetric(metrics, tag.allowKind, platform);
    }
}
//# sourceMappingURL=decision-attribution.js.map