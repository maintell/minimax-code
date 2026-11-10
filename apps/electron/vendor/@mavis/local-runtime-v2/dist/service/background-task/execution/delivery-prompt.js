export function buildBackgroundTaskDeliveryPrompt(tasks) {
    return [
        '<background-task-finished>',
        'Local background tasks have finished in this conversation.',
        ...tasks.map((task) => {
            const description = task.description
                ? ` description="${escapeXmlAttribute(task.description)}"`
                : '';
            const endedAt = task.endedAt === undefined ? '' : ` ended_at_ms="${task.endedAt}"`;
            return `  <task task_id="${escapeXmlAttribute(task.taskId)}" status="${task.status}"${description}${endedAt}/>`;
        }),
        'Use task_output with each task_id to read the results, then report the relevant results to the user as a normal assistant reply in this conversation.',
        'Do not mention this internal notice unless it is necessary to explain the results.',
        '</background-task-finished>',
    ].join('\n');
}
function escapeXmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
//# sourceMappingURL=delivery-prompt.js.map