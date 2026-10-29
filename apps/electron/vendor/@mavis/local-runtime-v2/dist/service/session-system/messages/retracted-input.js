import { readThreadGoalKickoffOriginRecord } from '@mavis/goal';
import { isLocallyOriginatedUserSource } from '@mavis/shared/local-user-input';
import { isOrdinaryQuestionnaireResponseOrigin, isQuestionnaireResponseOrigin, isQuestionnaireResponseText, } from '@mavis/shared/questionnaire';
export function describeRetractedInput(message) {
    if (!message)
        return {};
    const origin = message.sourceContext?.origin;
    if (isOrdinaryQuestionnaireResponseOrigin(origin)) {
        return { questionnaireRequestId: origin.requestId };
    }
    const content = typeof message.msg_content === 'string' ? message.msg_content : undefined;
    const text = content === undefined ? {} : { lastUserContent: content };
    const goalKickoff = readGoalKickoff(origin);
    if (goalKickoff)
        return { goalKickoff, ...text };
    return content !== undefined && isTypedHere(message.source, origin, content) ? text : {};
}
function isTypedHere(source, origin, content) {
    return (isLocallyOriginatedUserSource(source) &&
        !isQuestionnaireResponseOrigin(origin) &&
        !isQuestionnaireResponseText(content));
}
function readGoalKickoff(origin) {
    const record = readThreadGoalKickoffOriginRecord(origin);
    if (typeof record?.goalId !== 'string' || !record.goalId)
        return undefined;
    if (typeof record.objectiveDigest !== 'string' || !record.objectiveDigest)
        return undefined;
    return { goalId: record.goalId, objectiveDigest: record.objectiveDigest };
}
//# sourceMappingURL=retracted-input.js.map