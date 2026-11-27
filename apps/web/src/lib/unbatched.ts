/**
 * tRPC procedures sent on their own request instead of in the batch.
 * receivers.list, stations.schedule and signals.dayNight (which reads the same
 * schedule, #168) can wait on a third-party site (the receiver mirror,
 * eibispace.de); batched, they would hold up the fast database queries sent
 * alongside them. A test checks these exist.
 */
export const UNBATCHED_PATHS = new Set(["receivers.list", "stations.schedule", "signals.dayNight"]);
