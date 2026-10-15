import type { TrustedDevice } from "./api";

interface TrustedDevicesProps {
    devices: TrustedDevice[];
    onForget: (deviceId: string) => void;
}

/** Devices that have paired; they reconnect without a PIN until forgotten. */
export function TrustedDevices({ devices, onForget }: TrustedDevicesProps) {
    if (devices.length === 0) {
        return (
            <div className="empty-state compact">
                <strong>No paired devices</strong>
                <p>A device appears here after you pair with it using a PIN.</p>
            </div>
        );
    }

    return (
        <div className="trusted-list">
            {devices.map((device) => (
                <div className="trusted-row" key={device.deviceId}>
                    <div className="list-row-main">
                        <strong>{device.deviceName}</strong>
                        <span className="muted small">
                            Paired {new Date(device.pairedAt).toLocaleDateString()}
                            {device.lastSeenAt
                                ? ` · last connected ${new Date(device.lastSeenAt).toLocaleString()}`
                                : ""}
                        </span>
                    </div>

                    <button
                        className="btn btn-sm btn-danger"
                        onClick={() => onForget(device.deviceId)}
                    >
                        Forget
                    </button>
                </div>
            ))}
        </div>
    );
}
