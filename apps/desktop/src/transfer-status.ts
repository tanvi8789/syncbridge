import type { Transfer } from "./api";

const LIVE_STATES = new Set(["REQUESTED", "ACCEPTED", "TRANSFERRING", "PAUSED"]);

/** A transfer that is still waiting, running or paused. */
export function isLiveTransfer(transfer: Transfer): boolean {
    return LIVE_STATES.has(transfer.state);
}
