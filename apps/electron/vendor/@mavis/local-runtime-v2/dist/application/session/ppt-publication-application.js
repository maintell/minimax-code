/** Desktop receives a read-only projection; publication stays bound to the current Agent task. */
export class PptPreviewApplication {
    preview;
    proposals;
    constructor(preview, proposals) {
        this.preview = preview;
        this.proposals = proposals;
    }
    proposeEdits(input, signal) {
        if (!this.proposals)
            throw new Error('unsupported_edit');
        return this.proposals.propose(input, signal);
    }
    async listArtifacts(sessionId) {
        const result = (await this.preview.execute(sessionId, {
            action: 'list',
            schema: 'minimax.ppt-preview.list.v1',
        }));
        return result.artifacts;
    }
}
//# sourceMappingURL=ppt-publication-application.js.map