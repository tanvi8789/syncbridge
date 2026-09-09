/**
 * Common fields present in every SyncBridge protocol message.
 */
export interface BaseMessage {
    type: string;
    version: string;

    messageId: string;
    sessionId: string;

    timestamp: number;
    sequence: number;

    senderId: string;
}