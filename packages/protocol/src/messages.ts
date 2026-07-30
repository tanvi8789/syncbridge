import {
    DiscoverMessage,
    DiscoverResponseMessage,
} from "./discover";

export type ProtocolMessage =
    | DiscoverMessage
    | DiscoverResponseMessage;