/**
 * Common fields present in every SyncBridge protocol message.
 */
export interface BaseMessage {
    type: string;
    version: string;
    timestamp: number;
}