import type { KeyboardEvent } from "react";

export type PeerStatus = "discovered" | "pairing" | "connected";

export interface MapPeer {
    deviceId: string;
    name: string;
    status: PeerStatus;
}

interface NetworkMapProps {
    selfName: string;
    peers: MapPeer[];
    selectedId: string | null;
    onSelect: (deviceId: string) => void;
}

const WIDTH = 640;
const HEIGHT = 340;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const RX = 215;
const RY = 110;

function initials(name: string): string {
    const parts = name.split(/[\s._-]+/).filter(Boolean);

    if (parts.length === 0) {
        return "?";
    }

    return (
        parts.length === 1
            ? parts[0].slice(0, 2)
            : parts[0][0] + parts[1][0]
    ).toUpperCase();
}

function truncate(name: string, max = 16): string {
    return name.length > max ? `${name.slice(0, max - 1)}...` : name;
}

/**
 * This device in the middle, nearby devices around it. Peers are
 * placed by sorted device ID so they keep their position as others
 * come and go, and a link animates once a connection is live.
 */
export function NetworkMap({
    selfName,
    peers,
    selectedId,
    onSelect,
}: NetworkMapProps) {
    const sorted = [...peers].sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId)
    );

    const placed = sorted.map((peer, index) => {
        const angle =
            (index / Math.max(sorted.length, 1)) * Math.PI * 2 - Math.PI / 2;

        return {
            peer,
            x: CX + RX * Math.cos(angle),
            y: CY + RY * Math.sin(angle),
        };
    });

    const onKey = (event: KeyboardEvent, deviceId: string) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(deviceId);
        }
    };

    return (
        <svg
            className="netmap"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="group"
            aria-label="Nearby devices"
        >
            <ellipse
                className="netmap-ring"
                cx={CX}
                cy={CY}
                rx={RX * 0.55}
                ry={RY * 0.55}
            />
            <ellipse className="netmap-ring" cx={CX} cy={CY} rx={RX} ry={RY} />

            {sorted.length === 0 && (
                <>
                    <ellipse
                        className="netmap-sweep"
                        cx={CX}
                        cy={CY}
                        rx={RX}
                        ry={RY}
                    />
                    <ellipse
                        className="netmap-sweep netmap-sweep-late"
                        cx={CX}
                        cy={CY}
                        rx={RX}
                        ry={RY}
                    />
                </>
            )}

            {placed.map(({ peer, x, y }) => (
                <line
                    key={`link-${peer.deviceId}`}
                    className={`netmap-link ${peer.status}`}
                    x1={CX}
                    y1={CY}
                    x2={x}
                    y2={y}
                />
            ))}

            <g className="netmap-self">
                <circle cx={CX} cy={CY} r={34} />
                <text x={CX} y={CY} textAnchor="middle" dominantBaseline="central">
                    You
                </text>
                <text
                    className="netmap-caption"
                    x={CX}
                    y={CY + 54}
                    textAnchor="middle"
                >
                    {truncate(selfName, 22)}
                </text>
            </g>

            {placed.map(({ peer, x, y }) => (
                <g
                    key={peer.deviceId}
                    className={`netmap-node ${peer.status}${
                        selectedId === peer.deviceId ? " selected" : ""
                    }`}
                    transform={`translate(${x} ${y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${peer.name}, ${peer.status}`}
                    aria-pressed={selectedId === peer.deviceId}
                    onClick={() => onSelect(peer.deviceId)}
                    onKeyDown={(event) => onKey(event, peer.deviceId)}
                >
                    <g className="netmap-node-body">
                        <circle className="netmap-halo" r={34} />
                        <circle className="netmap-disc" r={26} />
                        <text textAnchor="middle" dominantBaseline="central">
                            {initials(peer.name)}
                        </text>
                        <text
                            className="netmap-caption"
                            y={46}
                            textAnchor="middle"
                        >
                            {truncate(peer.name)}
                        </text>
                    </g>
                </g>
            ))}
        </svg>
    );
}
