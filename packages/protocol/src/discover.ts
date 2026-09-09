import type { BaseMessage } from "./base.js";
import type { DeviceInfo } from "./device.js";

export interface DiscoverMessage extends BaseMessage {
    type: "DISCOVER";
}

export interface DiscoverResponseMessage extends BaseMessage {
    type: "DISCOVER_RESPONSE";
    device: DeviceInfo;
}