/**
 * Render the questionnaire as a numbered-text WeChat message body. Mirrors
 * the historical `feat/im-genui-full-mr` `renderQuestionnaireText` (introduced
 * by §4.1 round 2 W1, ported from the main branch's
 * `packages/daemon/src/channel-bridge/plugin-runner/questionnaire-ask-handler`):
 *   - Title line is `【请补充信息】<title>` (trailing space trimmed when no
 *     title).
 *   - Each step is `N. [<header> · ]<question>` (1-based, header is the
 *     optional context label the prompt may set; the bullet "·" only renders
 *     when a header exists).
 *   - Optional `(<description>)` and `[配图](<src>)` lines indented 3 spaces.
 *   - Options use a CONTINUOUS global counter spanning all steps so a typed
 *     integer maps unambiguously back to `(stepId, optionId)` — step 2's
 *     first option continues from step 1's last number.
 *   - Zero-option steps print `（请直接输入文字作答）`.
 *   - Trailer hint: `请回复编号选择（多选/多题用逗号分隔，中英文逗号均可，如 1,3 或 1，3）；无合适项可直接输入文字作答。`
 *
 * Copy is hardcoded to zh-Hans because WeChat has no client-language signal
 * (parity with the historical implementation).
 */
export function formatQuestionnaireText(renderable) {
    const lines = [];
    lines.push(`【请补充信息】${renderable.title ?? ''}`.trimEnd());
    let counter = 0;
    renderable.steps.forEach((step, stepIndex) => {
        lines.push('');
        lines.push(`${stepIndex + 1}. ${step.question}`);
        if (step.description?.trim())
            lines.push(`   (${step.description.trim()})`);
        for (const opt of step.options) {
            counter += 1;
            const desc = opt.description ? ` — ${opt.description}` : '';
            lines.push(`   ${counter}) ${opt.label}${desc}`);
        }
        if (step.options.length === 0) {
            lines.push('   （请直接输入文字作答）');
        }
    });
    lines.push('');
    lines.push('请回复编号选择（多选/多题用逗号分隔，中英文逗号均可，如 1,3 或 1，3）；无合适项可直接输入文字作答。');
    return lines.join('\n');
}
/**
 * Parse a free-text reply against ALL steps of the pending questionnaire,
 * using a continuous global option numbering (matches `formatQuestionnaireText`).
 *
 * Mapping rules ported from `feat/im-genui-full-mr`'s
 * `parseWechatQuestionnaireReply`:
 *   - Extract all integers from the text → map each back to (stepId, optionId)
 *     via the global numbering → group into per-step selectedOptionIds (a
 *     single-choice step keeps only the first selected option).
 *   - Separators are intentionally tolerant: ASCII `,`, Chinese full-width
 *     `，`, Chinese pause `、`, and any whitespace are all accepted (a user
 *     typing `1，3` or `1、3` or `1 3` all map identically to `1, 3`).
 *   - Remaining non-numeric free text → selectedOther=true / otherText. With
 *     one step it lands on that step; with multiple steps it lands on the
 *     first step that has no numeric answer (best-effort).
 *   - A step with no selection and no free text answer is omitted from the
 *     payload (the desktop questionnaire UI treats missing answers as
 *     "skipped" / "not required").
 */
export function parseNumberedReply(input) {
    const steps = input.request.steps ?? [];
    if (steps.length === 0)
        return null;
    // Build global numbering (1,2,3,… spanning steps).
    const numbering = [];
    let counter = 0;
    for (const step of steps) {
        for (const opt of step.options ?? []) {
            counter += 1;
            numbering.push({ index: counter, stepId: step.id, optionId: opt.id });
        }
    }
    const maxIndex = numbering.length;
    const trimmed = input.text.trim();
    // Collect selected numbers (only those within range).
    const numberMatches = trimmed.match(/\d+/g) ?? [];
    const selectedIndexes = numberMatches
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => n >= 1 && n <= maxIndex);
    // Free text = the message with all numbers + separators stripped.
    const freeText = trimmed
        .replace(/\d+/g, ' ')
        .replace(/[，,、\s]+/gu, ' ')
        .trim();
    const perStep = collectPerStepSelections(numbering, selectedIndexes);
    const freeTextStepId = resolveFreeTextStep(steps, perStep, freeText);
    const answers = buildNumberedAnswers({ steps, perStep, freeTextStepId, freeText });
    // If the reply produced nothing usable, fall back to "first step / other"
    // so the agent still sees an answer instead of dropping the user's reply.
    if (answers.length === 0) {
        return {
            schemaVersion: 2,
            requestId: input.request.id,
            submittedAt: Date.now(),
            answers: [
                {
                    stepId: steps[0].id,
                    selectedOptionIds: [],
                    selectedOther: true,
                    otherText: trimmed,
                },
            ],
        };
    }
    return {
        schemaVersion: 2,
        requestId: input.request.id,
        submittedAt: Date.now(),
        answers,
    };
}
/**
 * Build a `ChannelQuestionnairePending['request']` shell from a renderable.
 * Slice 2 stores this so a free-form reply can be mapped back to a
 * questionnaire even when the original `AskQuestionnaireRequest` is not on
 * hand (the questionnaire bridge keeps its own authoritative copy).
 */
export function pendingShellRequest(renderable) {
    return {
        schemaVersion: 2,
        id: renderable.requestId,
        ...(renderable.title ? { title: renderable.title } : {}),
        presentation: {
            replaceComposer: true,
            showProgress: true,
            allowBackNavigation: true,
        },
        steps: renderable.steps.map((step) => ({
            id: step.stepId,
            question: step.question,
            ...(step.description ? { description: step.description } : {}),
            selectionMode: step.selectionMode,
            allowOther: true,
            otherPlaceholder: 'Others...',
            required: true,
            options: step.options.map((option) => ({
                id: option.optionId,
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
            })),
        })),
    };
}
/** Per-step selected option ids (preserving user typing order). */
function collectPerStepSelections(numbering, selectedIndexes) {
    const perStep = new Map();
    for (const idx of selectedIndexes) {
        const entry = numbering.find((n) => n.index === idx);
        if (!entry)
            continue;
        const arr = perStep.get(entry.stepId) ?? [];
        if (!arr.includes(entry.optionId))
            arr.push(entry.optionId);
        perStep.set(entry.stepId, arr);
    }
    return perStep;
}
/** Free text lands on the single step, else the first unanswered, else step 1. */
function resolveFreeTextStep(steps, perStep, freeText) {
    if (!freeText)
        return undefined;
    if (steps.length === 1)
        return steps[0].id;
    const firstUnanswered = steps.find((s) => (perStep.get(s.id) ?? []).length === 0);
    return (firstUnanswered ?? steps[0]).id;
}
function buildNumberedAnswers(input) {
    const answers = [];
    for (const step of input.steps) {
        let selected = input.perStep.get(step.id) ?? [];
        if (step.selectionMode === 'single' && selected.length > 1) {
            selected = [selected[0]];
        }
        const isFreeTextStep = input.freeTextStepId === step.id;
        if (selected.length === 0 && !isFreeTextStep)
            continue;
        const answer = {
            stepId: step.id,
            selectedOptionIds: selected,
            selectedOther: isFreeTextStep,
        };
        if (isFreeTextStep)
            answer.otherText = input.freeText;
        answers.push(answer);
    }
    return answers;
}
//# sourceMappingURL=wechat-questionnaire.js.map