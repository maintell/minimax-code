/**
 * Merge request panel: GitLab merge requests and GitHub pull requests linked to
 * a Session. Everything is read through the user's own glab / gh login; the
 * runtime only runs "glab api" / "gh api" and never sees a token.
 */
export class MergeRequestError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'MergeRequestError';
        this.code = code;
    }
}
//# sourceMappingURL=contracts.js.map