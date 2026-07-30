import { BaseMessage } from "./base";
import { DeviceInfo } from "./device";

export interface DiscoverMessage extends BaseMessage {
    type: "DISCOVER";
}

export interface DiscoverResponseMessage extends BaseMessage {
    type: "DISCOVER_RESPONSE";
    device: DeviceInfo;
}