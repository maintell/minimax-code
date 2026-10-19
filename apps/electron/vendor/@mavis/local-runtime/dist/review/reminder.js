export function buildInlineReviewUserMessage(prepared, delivery = 'full') {
    return [buildInlineReviewReminder(prepared, delivery), '', prepared.request].join('\n');
}
export function buildInlineReviewReminder(prepared, delivery = 'full') {
    return [
        '<system-reminder>',
        '<code-review-instructions>',
        escapeReminderClosingTags(prepared.reviewPrompt),
        '</code-review-instructions>',
        delivery === 'git-discovery'
            ? buildGitDiscoveryScopeBlock()
            : buildReviewContextBlock(prepared),
        '</system-reminder>',
    ].join('\n');
}
export function buildSubagentReviewUserMessage(prepared) {
    return [
        '<system-reminder>',
        buildReviewContextBlock(prepared),
        '</system-reminder>',
        '',
        prepared.request,
    ].join('\n');
}
function buildReviewContextBlock(prepared) {
    const runtimeContext = {
        reviewRunId: prepared.context.reviewRunId,
        responseLanguage: prepared.context.responseLanguage,
        revisionStatus: prepared.context.revisionStatus,
        changedFiles: prepared.context.changedFiles
            ? [...prepared.context.changedFiles.values()]
            : undefined,
        warnings: prepared.context.warnings,
    };
    return ['<review-context>', serializeReminderData(runtimeContext), '</review-context>'].join('\n');
}
function buildGitDiscoveryScopeBlock() {
    return [
        '<review-scope source="git" manifest="omitted">',
        'The precomputed change manifest is omitted from this Review request.',
        'Inspect the complete local changes relative to HEAD with Git before returning findings.',
        '</review-scope>',
    ].join('\n');
}
function serializeReminderData(value) {
    return JSON.stringify(value)
        .replaceAll('&', '\\u0026')
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e');
}
function escapeReminderClosingTags(value) {
    return value.replace(/<\s*\/\s*(system-reminder|code-review-instructions|review-context|review-scope)\s*>/giu, (_match, tag) => `&lt;/${tag}&gt;`);
}
//# sourceMappingURL=reminder.js.map