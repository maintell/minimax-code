/** 单次抽取以完整且唯一的提交调用交付参数。 */
export function readMemorySubmission(result, toolName) {
    const calls = result.content.filter((part) => part.type === 'toolCall');
    const submission = calls[0];
    if (result.stopReason !== 'toolUse' ||
        calls.length !== 1 ||
        !submission ||
        submission.name !== toolName) {
        throw new SyntaxError('Expected exactly one completed memory submission tool call');
    }
    return submission.arguments;
}
//# sourceMappingURL=submission.js.map