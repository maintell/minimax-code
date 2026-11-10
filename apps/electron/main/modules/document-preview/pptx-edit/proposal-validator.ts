import { randomUUID } from "node:crypto";
import { decodePptxEditingTransactionV1 } from "@mavis/shared/pptx-editing";
/** Model output is data: only a bounded, scoped, typed transaction can be accepted. */
export function validatePptProposal(state, targetIds, response, textRange) {
    if (textRange) {
        const target = state.objects.find((object) => object.id === targetIds[0]);
        if (targetIds.length !== 1 ||
            target?.text == null ||
            textRange.start < 0 ||
            textRange.end <= textRange.start ||
            textRange.end > target.text.length)
            throw new Error('scope_violation');
        const projection = {
            ...state,
            objects: [{ ...target, text: target.text.slice(textRange.start, textRange.end) }],
        };
        const proposal = validatePptProposal(projection, targetIds, response);
        if (proposal.transaction.operations.some((op) => op.kind !== 'text' && op.kind !== 'text-style'))
            throw new Error('scope_violation');
        for (const operation of proposal.transaction.operations) {
            if (operation.kind === 'text' || operation.kind === 'text-style') {
                operation.start += textRange.start;
                operation.end += textRange.start;
            }
        }
        proposal.view = {
            ...proposal.view,
            changes: proposal.view.changes.map((change) => ({
                ...change,
                beforeText: target.text,
                afterText: target.text.slice(0, textRange.start) +
                    (change.afterText ?? '') +
                    target.text.slice(textRange.end),
            })),
        };
        return proposal;
    }
    if (response.length > 100000)
        throw new Error('proposal_failed');
    let decoded;
    try {
        decoded = JSON.parse(response
            .trim()
            .replace(/^```(?:json)?\s*/u, '')
            .replace(/\s*```$/u, ''));
    }
    catch {
        throw new Error('proposal_failed');
    }
    const raw = decoded;
    if (!raw || !Array.isArray(raw.operations) || !raw.operations.length)
        throw new Error('proposal_failed');
    const id = randomUUID();
    const targets = state.objects.filter((object) => targetIds.includes(object.id));
    if (targets.length !== targetIds.length)
        throw new Error('scope_violation');
    const transaction = decodePptxEditingTransactionV1({
        schema: 'mavis.pptx_transaction.v1',
        commandId: `proposal-${id}`,
        transactionId: `proposal-${id}`,
        baseRevision: state.revision,
        scope: targetIds,
        expectedVersions: Object.fromEntries(targets.map((object) => [object.id, object.version])),
        actor: 'agent',
        operations: raw.operations,
    });
    const texts = new Map(targets.map((object) => [object.id, object.text]));
    for (const operation of transaction.operations) {
        const object = targets.find((object) => object.id === operation.targetId);
        if (!object)
            throw new Error('scope_violation');
        const capability = operation.kind === 'appearance'
            ? 'appearance'
            : ['text', 'text-style', 'paragraph'].includes(operation.kind)
                ? 'text'
                : null;
        if (!capability || !object.editable.includes(capability))
            throw new Error('scope_violation');
        if (operation.kind === 'text' || operation.kind === 'text-style') {
            const before = texts.get(object.id);
            if (before === null || before === undefined)
                throw new Error('scope_violation');
            // A full rewrite/style addresses the original snapshot. Partial edits
            // must remain within the current scoped text and execute sequentially.
            if (operation.start === 0 && operation.end === object.text?.length)
                operation.end = before.length;
            if (operation.start < 0 || operation.end < operation.start || operation.end > before.length)
                throw new Error('scope_violation');
            if (operation.kind === 'text')
                texts.set(object.id, before.slice(0, operation.start) + operation.text + before.slice(operation.end));
        }
        else if (operation.kind === 'paragraph' &&
            operation.paragraphIndices.length === (object.textFormat?.paragraphs.length ?? 1))
            operation.paragraphIndices = (texts.get(object.id) ?? '')
                .split('\n')
                .map((_, index) => index);
    }
    const changes = targets
        .filter((object) => transaction.operations.some((operation) => operation.targetId === object.id))
        .map((object) => ({
        targetId: object.id,
        name: object.name,
        beforeText: object.text,
        afterText: texts.get(object.id) ?? null,
        beforeStyle: object.textStyle,
        beforeAppearance: object.appearance,
        operations: transaction.operations.filter((operation) => operation.targetId === object.id),
    }));
    return {
        transaction,
        view: {
            id,
            baseRevision: state.revision,
            expectedVersions: transaction.expectedVersions,
            changes,
        },
    };
}
