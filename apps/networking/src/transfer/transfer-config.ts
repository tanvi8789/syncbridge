export const TRANSFER_VERSION = "1.0.0";

/*
 * Raw file data carried inside each FILE_CHUNK message.
 *
 * We are starting conservatively because the data is
 * currently encoded as Base64 inside JSON.
 */
export const CHUNK_SIZE = 64 * 1024;

/*
 * How long the sender waits for ack progress before treating the
 * in-flight chunks as lost and resending them. TCP already
 * guarantees delivery on a live connection, so this mainly guards
 * against a stalled/unresponsive peer rather than real packet loss.
 */
export const CHUNK_ACK_TIMEOUT_MS = 5000;

/*
 * How often the sender emits a TRANSFER_PROGRESS event while a
 * transfer is running, so the UI gets a steady speed/ETA readout
 * without an event per chunk.
 */
export const PROGRESS_EVENT_INTERVAL_MS = 250;