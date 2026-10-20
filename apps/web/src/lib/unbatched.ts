/**
 * tRPC procedures sent on their own request instead of in the batch.
 * receivers.list can wait on a third-party mirror; batched, it would hold up
 * the fast database queries sent alongside it. A test checks these exist.
 */
export const UNBATCHED_PATHS = new Set(["receivers.list"]);
