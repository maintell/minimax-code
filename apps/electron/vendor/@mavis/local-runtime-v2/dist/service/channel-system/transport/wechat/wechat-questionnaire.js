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
 * Parse an inbound reply against ALL steps of the pending questionnaire,
 * using a continuous global option numbering (matches `formatQuestionnaireText`).
 *
 * Returns `null` — "this is not a questionnaire answer" — unless the trimmed
 * text consists solely of digits and separators AND at least one of those
 * numbers names an option. Everything else (free text, digits glued to words,
 * numbers that are all out of range) is an ordinary message for the agent.
 *
 * Mapping rules:
 *   - Extract all integers → map each back to (stepId, optionId) via the
 *     global numbering → group into per-step selectedOptionIds (a
 *     single-choice step keeps only the first selected option). Out-of-range
 *     numbers are ignored.
 *   - Separators are intentionally tolerant: ASCII `,`, Chinese full-width
 *     `，`, Chinese pause `、`, and any whitespace are all accepted (a user
 *     typing `1，3` or `1、3` or `1 3` all map identically to `1, 3`).
 *   - Every step gets an answer; a step with no in-range number is emitted as
 *     an explicit `skipped: true` answer (omitting it would make the server
 *     reject the whole reply, because every step is `required`).
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
    // A numbered answer is digits + separators and nothing else. Free text, or
    // digits glued to words ("2 换一批", "2024年"), is a normal message.
    if (!/^[\d\s,，、]+$/u.test(trimmed))
        return null;
    // Collect selected numbers (only those within range).
    const numberMatches = trimmed.match(/\d+/g) ?? [];
    const selectedIndexes = numberMatches
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => n >= 1 && n <= maxIndex);
    // Digits only, but none of them names an option ("99") — not an answer.
    if (selectedIndexes.length === 0)
        return null;
    return {
        schemaVersion: 2,
        requestId: input.request.id,
        submittedAt: Date.now(),
        answers: buildNumberedAnswers({
            steps,
            perStep: collectPerStepSelections(numbering, selectedIndexes),
        }),
    };
}
/**
 * Build a `ChannelQuestionnairePending['request']` shell from a renderable.
 * The adapter stores this so a numbered reply can be mapped back to a
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
/**
 * One answer per step, in request order. A step the user did not number is
 * emitted as an explicit `skipped: true` answer: omitting it would make the
 * server reject the whole reply, because `normalizeAskUserInput` pins every
 * step to `required: true`.
 */
function buildNumberedAnswers(input) {
    const answers = [];
    for (const step of input.steps) {
        let selected = input.perStep.get(step.id) ?? [];
        if (step.selectionMode === 'single' && selected.length > 1) {
            selected = [selected[0]];
        }
        answers.push(selected.length === 0
            ? { stepId: step.id, selectedOptionIds: [], selectedOther: false, skipped: true }
            : { stepId: step.id, selectedOptionIds: selected, selectedOther: false });
    }
    return answers;
}
//# sourceMappingURL=wechat-questionnaire.js.map