export const TRANSFER_VERSION = "1.0.0";

/*
 * Raw file data carried inside each FILE_CHUNK message.
 *
 * We are starting conservatively because the data is
 * currently encoded as Base64 inside JSON.
 */
export const CHUNK_SIZE = 64 * 1024;