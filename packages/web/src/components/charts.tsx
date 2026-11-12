import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useWidth } from "../lib/hooks.ts";
import { money, moneyCompact } from "../lib/format.ts";

/*
 * Hand-drawn SVG charts. Quiet by design: hairline grid, 2px lines, a light
 * wash under a line, bars with rounded data ends. Text always wears ink
 * colours; only marks carry the series colours.
 */

/** Round axis maximum and evenly spaced ticks for a positive range. */
function niceScale(min: number, max: number, count = 3): number[] {
  if (max <= min) return [min, min + 1];
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? rough;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; ; v += step) {
    ticks.push(Math.round(v));
    if (v >= max) break;
  }
  return [...new Set(ticks)];
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  // Keep the box inside the chart: flip to the left of the pointer past halfway.
  const left = x > width / 2;
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs shadow-lg"
      style={left ? { right: width - x + 10 } : { left: x + 10 }}
    >
      {children}
    </div>
  );
}

export interface LinePoint {
  label: string;
  value: number;
}

/** One series over time, with a crosshair and a readout. */
export function LineChart({ points, height = 200 }: { points: LinePoint[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 10, right: 12, bottom: 22, left: 46 };
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const margin = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
  const ticks = niceScale(lo - margin, hi + margin, 3);
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;
  const innerW = Math.max(width - pad.left - pad.right, 1);
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const last = points.length - 1;
  const shown = hover ?? last;
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(Math.floor(innerW / 64), 1)));

  const onMove = (clientX: number, rect: DOMRect) => {
    const ratio = (clientX - rect.left - pad.left) / innerW;
    setHover(Math.min(last, Math.max(0, Math.round(ratio * last))));
  };

  return (
    <div ref={ref} className="relative" style={{ height }}>
      {width > 0 && points.length > 0 && (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Line chart from ${points[0]!.label} to ${points[last]!.label}`}
            onPointerMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHover(null)}
            className="touch-pan-y"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" />
                <text x={pad.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--faint)" className="num">
                  {moneyCompact(t)}
                </text>
              </g>
            ))}
            {points.map(
              (p, i) =>
                (last - i) % labelEvery === 0 && (
                  <text
                    // biome-ignore lint/suspicious/noArrayIndexKey: points are a fixed time series
                    key={p.label + i}
                    x={x(i)}
                    y={height - 6}
                    textAnchor={i === last ? "end" : i === 0 ? "start" : "middle"}
                    fontSize="10.5"
                    fill="var(--faint)"
                  >
                    {p.label}
                  </text>
                ),
            )}
            <path d={`${path}L${x(last)},${pad.top + innerH}L${x(0)},${pad.top + innerH}Z`} fill="var(--series-1)" opacity="0.1" />
            <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--faint)" strokeWidth="1" />
            )}
            <circle cx={x(shown)} cy={y(points[shown]!.value)} r="4.5" fill="var(--series-1)" stroke="var(--panel)" strokeWidth="2" />
          </svg>
          {hover !== null && (
            <Tooltip x={x(hover)} width={width}>
              <div className="text-muted">{points[hover]!.label}</div>
              <div className="num font-medium">{money(points[hover]!.value, { whole: true })}</div>
            </Tooltip>
          )}
        </>
      )}
    </div>
  );
}

/** A bare trend line for a tile. No axes: the number beside it carries the value. */
export function Sparkline({ values, height = 36 }: { values: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i: number) => 2 + (i / Math.max(values.length - 1, 1)) * (width - 8);
  const y = (v: number) => height - 4 - ((v - lo) / (hi - lo || 1)) * (height - 8);
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <div ref={ref} style={{ height }} aria-hidden="true">
      {width > 0 && values.length > 1 && (
        <svg width={width} height={height}>
          <title>Trend</title>
          <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(values.length - 1)} cy={y(values[values.length - 1]!)} r="3.5" fill="var(--series-1)" stroke="var(--panel)" strokeWidth="2" />
        </svg>
      )}
    </div>
  );
}

export interface BarSeries {
  name: string;
  color: string;
}

export interface BarGroup {
  key: string;
  label: string;
  /** Longer label for the readout. */
  title: string;
  values: number[];
  /** Where each bar leads when clicked. */
  links: string[];
}

/** Columns by month: one or two series side by side. Every bar is a link. */
export function ColumnChart({
  series,
  groups,
  height = 190,
  selected,
  footer,
}: {
  series: BarSeries[];
  groups: BarGroup[];
  height?: number;
  selected?: string;
  footer?: (group: BarGroup) => ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const navigate = useNavigate();
  const pad = { top: 8, right: 4, bottom: 22, left: 40 };
  const max = Math.max(10_000, ...groups.flatMap((g) => g.values));
  const ticks = niceScale(0, max, 3);
  const yMax = ticks[ticks.length - 1]!;
  const innerW = Math.max(width - pad.left - pad.right, 1);
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / Math.max(groups.length, 1);
  const gap = 2;
  const barW = Math.max(3, Math.min(18, (band - 10 - gap * (series.length - 1)) / series.length));
  const y = (v: number) => pad.top + innerH - (Math.max(v, 0) / yMax) * innerH;
  const base = pad.top + innerH;

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-2 flex gap-4 text-xs text-muted">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <>
            <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.name).join(" and ")} by month`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" />
                  <text x={pad.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--faint)" className="num">
                    {moneyCompact(t)}
                  </text>
                </g>
              ))}
              {groups.map((g, i) => {
                const cx = pad.left + band * i + band / 2;
                const total = barW * series.length + gap * (series.length - 1);
                const dim = (hover !== null && hover !== i) || (selected !== undefined && hover === null && selected !== g.key);
                return (
                  <g key={g.key} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                    {/* The hit area is the whole band, far bigger than the bars. */}
                    <rect x={pad.left + band * i} y={pad.top} width={band} height={innerH + pad.bottom} fill="transparent" />
                    {g.values.map((v, s) => {
                      const left = cx - total / 2 + s * (barW + gap);
                      const top = y(v);
                      const h = base - top;
                      const r = Math.min(4, barW / 2, h);
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: a bar in an SVG chart, not an HTML link
                        <path
                          key={series[s]!.name}
                          d={`M${left},${base}V${top + r}Q${left},${top} ${left + r},${top}H${left + barW - r}Q${left + barW},${top} ${left + barW},${top + r}V${base}Z`}
                          fill={series[s]!.color}
                          opacity={dim ? 0.45 : 1}
                          className="cursor-pointer"
                          role="link"
                          tabIndex={0}
                          aria-label={`${series[s]!.name}, ${g.title}: ${money(v, { whole: true })}`}
                          onClick={() => navigate(g.links[s]!)}
                          onKeyDown={(e) => e.key === "Enter" && navigate(g.links[s]!)}
                        />
                      );
                    })}
                    <text
                      x={cx}
                      y={height - 6}
                      textAnchor="middle"
                      fontSize="10.5"
                      fill={selected === g.key ? "var(--ink)" : "var(--faint)"}
                      fontWeight={selected === g.key ? 600 : 400}
                    >
                      {g.label}
                    </text>
                  </g>
                );
              })}
            </svg>
            {hover !== null && groups[hover] && (
              <Tooltip x={pad.left + band * hover + band / 2} width={width}>
                <div className="mb-0.5 text-muted">{groups[hover].title}</div>
                {series.map((s, i) => (
                  <div key={s.name} className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
                      {s.name}
                    </span>
                    <span className="num font-medium">{money(groups[hover]!.values[i], { whole: true })}</span>
                  </div>
                ))}
                {footer?.(groups[hover])}
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  sub?: string;
  value: number;
  to: string;
}

/** Ranked horizontal bars: the label and amount are text, the bar is the magnitude. */
export function BarList({ rows, total, scale }: { rows: BarRow[]; total?: number; scale?: number }) {
  // Lists that sit together share one scale, so their bars can be compared.
  const max = scale ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.key}>
          <Link to={r.to} className="group block rounded-md px-4 py-1.5 hover:bg-raised">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[13px]">
                {r.label}
                {r.sub && <span className="ml-2 text-xs text-faint">{r.sub}</span>}
              </span>
              <span className="num shrink-0 text-[13px]">
                {money(r.value, { whole: true })}
                {total ? <span className="ml-2 inline-block w-8 text-right text-xs text-faint">{Math.round((r.value / total) * 100)}%</span> : null}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-line-soft">
              <div className="h-1.5 rounded-full bg-series-1" style={{ width: `${Math.max((r.value / max) * 100, 0.8)}%` }} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export interface FlowNode {
  key: string;
  label: string;
  value: number;
  to?: string;
}

/**
 * Where the money came from and where it went: sources on the left, one
 * trunk in the middle, destinations on the right. Heights are to scale.
 */
export function FlowChart({ sources, targets, hub }: { sources: FlowNode[]; targets: FlowNode[]; hub: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const navigate = useNavigate();
  const narrow = width < 520;
  const labelL = narrow ? 88 : 150;
  const labelR = narrow ? 104 : 170;
  const node = 8;
  const gap = 8;
  const total = Math.max(1, sources.reduce((n, s) => n + s.value, 0), targets.reduce((n, t) => n + t.value, 0));
  const scale = 220 / total;
  // Every node gets room for its two-line label, however small its bar.
  const slot = (n: FlowNode) => Math.max(n.value * scale, 28);
  const span = (nodes: FlowNode[]) => nodes.reduce((sum, n) => sum + slot(n), 0) + gap * Math.max(nodes.length - 1, 0);
  const height = Math.max(span(sources), span(targets), 220) + 24;
  const xL = labelL;
  const xR = width - labelR - node;
  const xHub = (xL + node + xR) / 2 - node / 2;

  const stack = (nodes: FlowNode[]) => {
    let top = (height - span(nodes)) / 2;
    return nodes.map((n) => {
      const h = Math.max(n.value * scale, 1.5);
      const y = top + (slot(n) - h) / 2;
      top += slot(n) + gap;
      return { ...n, y, h };
    });
  };
  const left = stack(sources);
  const right = stack(targets);
  const hubH = total * scale;
  const hubY = (height - hubH) / 2;

  // A ribbon between two vertical spans, as a filled cubic curve.
  const ribbon = (x1: number, y1: number, h1: number, x2: number, y2: number, h2: number) => {
    const mid = (x1 + x2) / 2;
    return `M${x1},${y1}C${mid},${y1} ${mid},${y2} ${x2},${y2}V${y2 + h2}C${mid},${y2 + h2} ${mid},${y1 + h1} ${x1},${y1 + h1}Z`;
  };

  let inY = hubY;
  let outY = hubY;
  const label = (n: FlowNode & { y: number; h: number }, side: "left" | "right") => {
    const x = side === "left" ? xL - 8 : xR + node + 8;
    const mid = n.y + n.h / 2;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: only clickable when it has a role and a destination
      <g
        key={`${side}-${n.key}`}
        className={n.to ? "cursor-pointer" : undefined}
        role={n.to ? "link" : undefined}
        tabIndex={n.to ? 0 : undefined}
        onClick={() => n.to && navigate(n.to)}
        onKeyDown={(e) => e.key === "Enter" && n.to && navigate(n.to)}
      >
        <text x={x} y={mid - 2} textAnchor={side === "left" ? "end" : "start"} fontSize="11.5" fill="var(--ink)">
          {n.label}
        </text>
        <text x={x} y={mid + 11} textAnchor={side === "left" ? "end" : "start"} fontSize="10.5" fill="var(--faint)" className="num">
          {money(n.value, { whole: true })}
        </text>
      </g>
    );
  };

  return (
    <div ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Flow of ${hub.toLowerCase()} into spending and savings`}>
          {left.map((n) => {
            const d = ribbon(xL + node, n.y, n.h, xHub, inY, n.h);
            inY += n.value * scale;
            return <path key={n.key} d={d} fill="var(--series-2)" opacity="0.22" />;
          })}
          {right.map((n) => {
            const d = ribbon(xHub + node, outY, n.h, xR, n.y, n.h);
            outY += n.value * scale;
            return <path key={n.key} d={d} fill="var(--series-1)" opacity="0.22" />;
          })}
          {left.map((n) => (
            <rect key={n.key} x={xL} y={n.y} width={node} height={n.h} rx="2" fill="var(--series-2)" />
          ))}
          {right.map((n) => (
            <rect key={n.key} x={xR} y={n.y} width={node} height={n.h} rx="2" fill="var(--series-1)" />
          ))}
          <rect x={xHub} y={hubY} width={node} height={hubH} rx="2" fill="var(--muted)" />
          {!narrow && (
            <text x={xHub + node / 2} y={Math.max(hubY - 6, 10)} textAnchor="middle" fontSize="10.5" fill="var(--faint)">
              {hub}
            </text>
          )}
          {left.map((n) => label(n, "left"))}
          {right.map((n) => label(n, "right"))}
        </svg>
      )}
    </div>
  );
}
