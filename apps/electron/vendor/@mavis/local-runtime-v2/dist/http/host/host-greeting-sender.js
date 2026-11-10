export class LocalGreetingSystemReminderSender {
    options;
    constructor(options) {
        this.options = options;
    }
    async sendSystemReminder(input) {
        const session = await this.options.getSessionById(input.sessionId);
        if (!session || session.agentName !== input.agentName) {
            throw new Error(`Greeting session is unavailable for ${input.agentName}`);
        }
        const accepted = await this.options.submitConversationTurn({
            sessionId: input.sessionId,
            content: input.content,
            requestedTurnId: input.requestedTurnId,
        });
        return { status: 'accepted', turnId: accepted.turnId };
    }
}
//# sourceMappingURL=host-greeting-sender.js.map