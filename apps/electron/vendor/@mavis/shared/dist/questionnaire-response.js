import { translateRuntimeText } from './runtime-i18n/index.js';
/**
 * Serialize the structured questionnaire reply sent to the runtime/model.
 * Keep this in shared code so optimistic UI and the canonical runtime message
 * use the same bytes and locale-aware Q/A summary.
 */
export function serializeQuestionnaireResponse(payload, request) {
    const lines = [
        '<questionnaire-response>',
        `  <requestId>${escapeXml(payload.requestId)}</requestId>`,
        `  <schemaVersion>${payload.schemaVersion}</schemaVersion>`,
        `  <submittedAt>${payload.submittedAt}</submittedAt>`,
    ];
    if (request?.mode)
        lines.push(`  <mode>${escapeXml(request.mode)}</mode>`);
    if (payload.source) {
        lines.push(`  <responseSource>${escapeXml(payload.source)}</responseSource>`);
        lines.push(`  <explicitUserConfirmation>${payload.source === 'user' ? 'true' : 'false'}</explicitUserConfirmation>`);
    }
    if (request?.mode === 'feature-enable' && request.modePayload?.featureKey) {
        lines.push(`  <featureKey>${escapeXml(request.modePayload.featureKey)}</featureKey>`);
    }
    lines.push('  <answers>');
    for (const answer of payload.answers)
        lines.push(serializeAnswer(answer));
    lines.push('  </answers>');
    lines.push('</questionnaire-response>');
    return lines.join('\n');
}
export function serializeQuestionnaireResponseMessage(request, reply, locale) {
    const response = serializeQuestionnaireResponse(reply, request);
    return request.mode === 'feature-enable'
        ? response
        : `${response}\n\n${formatAnswersAsText(request, reply.answers, locale)}`;
}
export function formatAnswersAsText(request, answers, locale) {
    return resolveQuestionnaireAnswers(request, answers, locale)
        .map(({ question, answer }) => `Q: ${escapeMarkdown(question)}  \nA: ${escapeMarkdown(answer)}`)
        .join('\n\n');
}
/** Persist plain Q/A alongside the model transcript, including multiline free text. */
export function resolveQuestionnaireAnswers(request, answers, locale) {
    const noAnswer = translateRuntimeText(locale, 'questionnaire.noAnswer');
    const others = translateRuntimeText(locale, 'questionnaire.others');
    const stepById = new Map(request.steps.map((step) => [step.id, step]));
    return answers.flatMap((answer) => {
        const step = stepById.get(answer.stepId);
        if (!step)
            return [];
        const parts = answer.selectedOptionIds.map((id) => step.options.find((option) => option.id === id)?.label ?? id);
        if (answer.selectedOther && answer.otherText)
            parts.push(`${others}: ${answer.otherText}`);
        return [
            { question: step.question, answer: answer.skipped ? noAnswer : parts.join(', ') || noAnswer },
        ];
    });
}
function serializeAnswer(answer) {
    const lines = ['  <answer>'];
    lines.push(`    <stepId>${escapeXml(answer.stepId)}</stepId>`);
    if (answer.skipped) {
        lines.push('    <skipped>true</skipped>');
        lines.push('  </answer>');
        return lines.join('\n');
    }
    if (answer.selectedOptionIds.length > 0) {
        lines.push('    <selectedOptions>');
        for (const id of answer.selectedOptionIds)
            lines.push(`      <item>${escapeXml(id)}</item>`);
        lines.push('    </selectedOptions>');
    }
    if (answer.selectedOther) {
        lines.push('    <selectedOther>true</selectedOther>');
        if (answer.otherText)
            lines.push(`    <otherText>${escapeXml(answer.otherText)}</otherText>`);
    }
    lines.push('  </answer>');
    return lines.join('\n');
}
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function escapeMarkdown(text) {
    return text.replace(/([\\`*_[~])/g, '\\$1');
}
//# sourceMappingURL=questionnaire-response.js.map