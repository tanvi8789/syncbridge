import { useId, useState } from "react";

/*
 * Small hand-rolled SVG chart primitives.
 *
 * No charting library: the project has no runtime dependencies
 * outside React, and these four forms are all the dashboard needs.
 *
 * Shared mark specs, applied by every chart here:
 *   - bars capped at 24px thick, with a 4px rounded data-end and a
 *     square baseline end (so the bar grows out of the axis)
 *   - a 2px surface-coloured gap between touching marks
 *   - 2px lines, round joins; end markers r>=4 with a 2px surface ring
 *   - area fills at 10% opacity — a wash, never a block
 *   - hairline solid gridlines, recessive
 *   - values and labels wear text tokens, never the series colour
 */

export interface ChartPoint {
    label: string;
    value: number;
    /** Extra lines shown in the tooltip, e.g. "4 transfers". */
    detail?: string[];
}

interface TooltipState {
    /** Horizontal position as a percentage of the plot width. */
    xPercent: number;
    title: string;
    value: string;
    detail?: string[];
}

function Tooltip({ state }: { state: TooltipState | null }) {
    if (!state) {
        return null;
    }

    /*
     * Clamped away from the edges so a tooltip on the first or last
     * band isn't half outside the card.
     */
    const left = Math.min(Math.max(state.xPercent, 8), 92);

    return (
        <div
            className="viz-tooltip"
            style={{ left: `${left}%` }}
            role="tooltip"
        >
            {/* Value leads, label follows — the reader already knows the series. */}
            <strong>{state.value}</strong>
            <span>{state.title}</span>

            {state.detail?.map((line) => (
                <span key={line}>{line}</span>
            ))}
        </div>
    );
}

/** Round a maximum up to a clean axis top (1/2/5 × 10^n). */
function niceMax(value: number): number {
    if (value <= 0) {
        return 1;
    }

    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;

    /*
     * A coarse 1/2/5/10 ladder rounds 2.3 up to 5, leaving the data
     * squashed into the bottom half of the plot, so the steps are
     * finer than the textbook set.
     */
    const step = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(
        (candidate) => normalized <= candidate
    );

    return (step ?? 10) * magnitude;
}

/* ---------------------------------------------------------------
   Columns — magnitude over time, one sequential hue
   --------------------------------------------------------------- */

export function ColumnChart({
    points,
    formatValue,
}: {
    points: ChartPoint[];
    formatValue: (value: number) => string;
}) {
    const [tooltip, setTooltip] = useState<TooltipState | null>(null);

    if (points.length === 0) {
        return <p className="viz-empty">No data yet.</p>;
    }

    const max = niceMax(Math.max(...points.map((p) => p.value)));

    /*
     * Laid out in HTML rather than SVG: a viewBox stretched with
     * preserveAspectRatio="none" makes "24px" mean whatever the
     * horizontal scale factor says, so the mark-thickness cap can
     * only be honoured in real CSS pixels.
     */
    return (
        <div className="viz-plot">
            <div className="viz-columns" role="img" aria-label={`Column chart, ${points.length} points, maximum ${formatValue(max)}`}>
                <span className="viz-gridlines" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                </span>

                {points.map((point, index) => {
                    const show: TooltipState = {
                        xPercent: ((index + 0.5) / points.length) * 100,
                        title: point.label,
                        value: formatValue(point.value),
                        detail: point.detail,
                    };

                    return (
                        <button
                            type="button"
                            key={point.label}
                            className="viz-column"
                            aria-label={`${point.label}: ${formatValue(point.value)}`}
                            onMouseEnter={() => setTooltip(show)}
                            onMouseLeave={() => setTooltip(null)}
                            onFocus={() => setTooltip(show)}
                            onBlur={() => setTooltip(null)}
                        >
                            <span
                                className="viz-column-fill"
                                style={{
                                    height: `${
                                        max > 0
                                            ? Math.max((point.value / max) * 100, 0.6)
                                            : 0
                                    }%`,
                                }}
                            />
                        </button>
                    );
                })}
            </div>

            <div className="viz-axis-x">
                <span>{points[0].label}</span>

                {points.length > 1 && (
                    <span>{points[points.length - 1].label}</span>
                )}
            </div>

            <span className="viz-axis-max">{formatValue(max)}</span>

            <Tooltip state={tooltip} />
        </div>
    );
}

/* ---------------------------------------------------------------
   Line — a trend, single series
   --------------------------------------------------------------- */

export function LineChart({
    points,
    formatValue,
    height = 160,
}: {
    points: ChartPoint[];
    formatValue: (value: number) => string;
    height?: number;
}) {
    const [hovered, setHovered] = useState<number | null>(null);
    const gradientId = useId();

    if (points.length === 0) {
        return <p className="viz-empty">No data yet.</p>;
    }

    if (points.length === 1) {
        /*
         * One point is not a trend. Showing a single dot floating in
         * an empty plot implies a line that was never measured, so
         * the value is stated plainly instead.
         */
        return (
            <p className="viz-single">
                <strong>{formatValue(points[0].value)}</strong>
                <span>{points[0].label} — one data point so far</span>
            </p>
        );
    }

    const width = 100;
    const padTop = 10;
    const padBottom = 18;
    const plotHeight = height - padTop - padBottom;

    const max = niceMax(Math.max(...points.map((p) => p.value)));

    const coords = points.map((point, index) => ({
        x: (index / (points.length - 1)) * width,
        y: padTop + plotHeight - (max > 0 ? (point.value / max) * plotHeight : 0),
        point,
    }));

    const linePath = coords
        .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`)
        .join(" ");

    const areaPath = `${linePath} L ${width} ${padTop + plotHeight} L 0 ${
        padTop + plotHeight
    } Z`;

    const active = hovered !== null ? coords[hovered] : undefined;

    return (
        <div className="viz-plot">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                preserveAspectRatio="none"
                className="viz-svg"
                role="img"
                aria-label={`Line chart, ${points.length} points, maximum ${formatValue(max)}`}
            >
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" className="viz-area-top" />
                        <stop offset="100%" className="viz-area-bottom" />
                    </linearGradient>
                </defs>

                {[0, 0.5, 1].map((fraction) => (
                    <line
                        key={fraction}
                        x1={0}
                        x2={width}
                        y1={padTop + plotHeight * fraction}
                        y2={padTop + plotHeight * fraction}
                        className="viz-gridline"
                        vectorEffect="non-scaling-stroke"
                    />
                ))}

                <path d={areaPath} fill={`url(#${gradientId})`} />

                <path
                    d={linePath}
                    className="viz-line"
                    vectorEffect="non-scaling-stroke"
                />

                {active && (
                    <line
                        x1={active.x}
                        x2={active.x}
                        y1={padTop}
                        y2={padTop + plotHeight}
                        className="viz-crosshair"
                        vectorEffect="non-scaling-stroke"
                    />
                )}

                {/*
                 * Bands rather than per-point targets: the reader
                 * aims at a date, and only has to be nearest to it.
                 */}
                {coords.map((c, index) => (
                    <rect
                        key={c.point.label}
                        x={(index / coords.length) * width}
                        y={0}
                        width={width / coords.length}
                        height={height}
                        fill="transparent"
                        tabIndex={0}
                        role="button"
                        aria-label={`${c.point.label}: ${formatValue(c.point.value)}`}
                        onMouseEnter={() => setHovered(index)}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(index)}
                        onBlur={() => setHovered(null)}
                    />
                ))}
            </svg>

            {/*
             * Markers live in an unscaled overlay so the non-uniform
             * viewBox scaling can't turn the circles into ellipses.
             */}
            <div className="viz-markers">
                {active && (
                    <span
                        className="viz-marker"
                        style={{
                            left: `${active.x}%`,
                            top: `${(active.y / height) * 100}%`,
                        }}
                    />
                )}
            </div>

            <div className="viz-axis-x">
                <span>{points[0].label}</span>
                <span>{points[points.length - 1].label}</span>
            </div>

            <span className="viz-axis-max">{formatValue(max)}</span>

            {active && (
                <Tooltip
                    state={{
                        xPercent: active.x,
                        title: active.point.label,
                        value: formatValue(active.point.value),
                        detail: active.point.detail,
                    }}
                />
            )}
        </div>
    );
}

/* ---------------------------------------------------------------
   Horizontal bars — ranked magnitude, one sequential hue
   --------------------------------------------------------------- */

export function RankedBars({
    points,
    formatValue,
}: {
    points: ChartPoint[];
    formatValue: (value: number) => string;
}) {
    if (points.length === 0) {
        return <p className="viz-empty">No data yet.</p>;
    }

    const max = Math.max(...points.map((p) => p.value), 1);

    return (
        <ul className="viz-ranked">
            {points.map((point) => (
                <li key={point.label}>
                    <span className="viz-ranked-label" title={point.label}>
                        {point.label}
                    </span>

                    <span className="viz-ranked-track" aria-hidden="true">
                        <span
                            className="viz-ranked-fill"
                            style={{
                                width: `${Math.max(
                                    (point.value / max) * 100,
                                    0.6
                                )}%`,
                            }}
                        />
                    </span>

                    {/* Direct label at the bar tip — few enough rows to label every one. */}
                    <span className="viz-ranked-value">
                        {formatValue(point.value)}

                        {point.detail?.[0] && (
                            <small>{point.detail[0]}</small>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/* ---------------------------------------------------------------
   Split bar — part-to-whole across two categorical series
   --------------------------------------------------------------- */

export function SplitBar({
    segments,
    formatValue,
}: {
    segments: Array<{ label: string; value: number; series: 1 | 2 }>;
    formatValue: (value: number) => string;
}) {
    const total = segments.reduce((sum, segment) => sum + segment.value, 0);

    if (total === 0) {
        return <p className="viz-empty">No data yet.</p>;
    }

    return (
        <div className="viz-split">
            <div className="viz-split-track">
                {segments
                    .filter((segment) => segment.value > 0)
                    .map((segment) => (
                        <span
                            key={segment.label}
                            className={`viz-split-fill viz-series-${segment.series}`}
                            style={{
                                flexGrow: segment.value,
                            }}
                            title={`${segment.label}: ${formatValue(segment.value)}`}
                        />
                    ))}
            </div>

            {/* Two series, so a legend is always present. */}
            <ul className="viz-legend">
                {segments.map((segment) => (
                    <li key={segment.label}>
                        <span
                            className={`viz-swatch viz-series-${segment.series}`}
                            aria-hidden="true"
                        />

                        <span className="viz-legend-label">{segment.label}</span>

                        <strong>{formatValue(segment.value)}</strong>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/* ---------------------------------------------------------------
   Stat tile
   --------------------------------------------------------------- */

export function StatTile({
    label,
    value,
    hint,
    hero,
}: {
    label: string;
    value: string;
    hint?: string;
    hero?: boolean;
}) {
    return (
        <div className={`stat-tile${hero ? " stat-tile-hero" : ""}`}>
            <span className="stat-tile-label">{label}</span>
            <strong className="stat-tile-value">{value}</strong>
            {hint && <span className="stat-tile-hint">{hint}</span>}
        </div>
    );
}
