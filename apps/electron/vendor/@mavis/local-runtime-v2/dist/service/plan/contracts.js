export const PLAN_ADMISSION_POLICY_REJECTIONS = {
    lifecycleActive: 'policy:plan:lifecycle-active',
    questionnaireActive: 'policy:plan:questionnaire-active',
    entryDisabled: 'policy:plan:entry-disabled',
    modeConflict: 'policy:plan:mode-conflict',
};
export function planEntryPreparationPolicyRejection(reason) {
    if (reason === 'plan-lifecycle-active') {
        return PLAN_ADMISSION_POLICY_REJECTIONS.lifecycleActive;
    }
    if (reason === 'plan-questionnaire-active') {
        return PLAN_ADMISSION_POLICY_REJECTIONS.questionnaireActive;
    }
    if (reason === 'plan-entry-disabled')
        return PLAN_ADMISSION_POLICY_REJECTIONS.entryDisabled;
    return PLAN_ADMISSION_POLICY_REJECTIONS.modeConflict;
}
//# sourceMappingURL=contracts.js.map