import type {
    DiscoverMessage,
    DiscoverResponseMessage,
} from "./discover.js";

import type {
    ConnectRequestMessage,
    ConnectAcceptMessage,
    ConnectRejectMessage,
} from "./connect.js";

import type {
    TransferStartMessage,
    ChunkMessage,
    ChunkAckMessage,
    VerifyRequestMessage,
    VerifySuccessMessage,
    TransferCompleteMessage,
} from "./transfer.js";

export type ProtocolMessage =
    | DiscoverMessage
    | DiscoverResponseMessage
    | ConnectRequestMessage
    | ConnectAcceptMessage
    | ConnectRejectMessage
    | TransferStartMessage
    | ChunkMessage
    | ChunkAckMessage
    | VerifyRequestMessage
    | VerifySuccessMessage
    | TransferCompleteMessage;