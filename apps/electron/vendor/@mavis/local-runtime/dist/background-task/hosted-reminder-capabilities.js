export function createHostedBackgroundReminderCapabilities(service) {
    return {
        buildBackground: async (input) => {
            const snapshot = await service.reminderSnapshot(input.session);
            return {
                tasks: snapshot.tasks.map((task) => ({
                    taskId: task.taskId,
                    status: task.status,
                    ...(task.endedAt === undefined ? {} : { endedAtMs: task.endedAt }),
                })),
                undeliveredTotal: snapshot.undeliveredTotal,
                terminalTotal: snapshot.terminalTotal,
            };
        },
        confirmBackgroundTaskReads: async (input) => (await service.markDelivered(input.sessionId, [...input.taskIds])).map((task) => task.taskId),
    };
}
//# sourceMappingURL=hosted-reminder-capabilities.js.map