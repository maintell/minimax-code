/**
 * The async review surface this package declares on purpose: the verdict contract a
 * review writes and Bunny reads, the `<review-target>` block a review dispatch carries
 * together with the parser that reads it back, and the referenced-session read contract
 * the reference-consumption probe reports through.
 *
 * The read contract is owned by the probe in Session System and only consumed by Bunny's
 * round budget, so this coordination-domain barrel re-exports it from Session System
 * rather than reaching into the Bunny product service.
 *
 * Nothing in production imports these yet — the reviewer side and the probe land in
 * later MRs — so this barrel is registered in the package's knip entry list, the
 * established way this package declares an intentional public surface (see the existing
 * `workspace-indexing-types.ts` entry). It is a declaration with named consumers ahead
 * of it, not dead code left behind by a refactor.
 */
export { REVIEW_TARGET_CLOSE, REVIEW_TARGET_OPEN, renderReviewTarget, } from '../review-target.js';
export { parseSelectionRefs } from '../review-target-reader.js';
export {} from '../../session-system/index.js';
//# sourceMappingURL=index.js.map