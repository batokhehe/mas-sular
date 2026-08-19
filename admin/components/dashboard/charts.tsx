'use client';

// Dependency-free charts (pure SVG). The admin app ships no chart library, so we
// avoid adding a heavy one for a handful of widgets.

type TrendPoint = { label: string; value: number };

/** Responsive area/line chart. Scales to its container width via a viewBox. */
export function TrendChart({ points, color = '#465fff', height = 220 }: { points: TrendPoint[]; color?: string; height?: number }) {
  const W = 600;
  const H = 200;
  const pad = 8;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const x = (i: number) => (n <= 1 ? pad : pad + (i * (W - pad * 2)) / (n - 1));
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(n - 1).toFixed(1)} ${H - pad} L ${x(0).toFixed(1)} ${H - pad} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label="Trend chart">
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={pad} x2={W - pad} y1={H * f} y2={H * f} stroke="#f1f5f9" strokeWidth="1" />
      ))}
      {n > 0 ? (
        <>
          <path d={area} fill="url(#trend-fill)" />
          <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  );
}

/** Simple responsive bar chart (dependency-free SVG). */
export function BarChart({ values, color = '#ef4444', height = 160 }: { values: number[]; color?: string; height?: number }) {
  const W = 600;
  const H = 160;
  const pad = 6;
  const max = Math.max(1, ...values);
  const n = values.length;
  const bw = n > 0 ? (W - pad * 2) / n : 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label="Bar chart">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={pad} x2={W - pad} y1={H * f} y2={H * f} stroke="#f1f5f9" strokeWidth="1" />
      ))}
      {values.map((v, i) => {
        const h = (v / max) * (H - pad * 2);
        return <rect key={i} x={pad + i * bw + bw * 0.15} y={H - pad - h} width={bw * 0.7} height={Math.max(0, h)} rx="1.5" fill={color} opacity={0.85} />;
      })}
    </svg>
  );
}

type Segment = { label: string; value: number; color: string };

/** Donut chart with a centered total and a legend. */
export function DonutChart({ segments, size = 168 }: { segments: Segment[]; size?: number }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const r = 54;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <svg width={size} height={size} viewBox="0 0 140 140" className="shrink-0">
        <circle cx="70" cy="70" r={r} fill="none" stroke="#f1f5f9" strokeWidth="18" />
        {total > 0
          ? segments.map((s) => {
              const frac = s.value / total;
              const dash = `${frac * c} ${c - frac * c}`;
              const el = (
                <circle
                  key={s.label}
                  cx="70"
                  cy="70"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="18"
                  strokeDasharray={dash}
                  strokeDashoffset={-offset * c}
                  transform="rotate(-90 70 70)"
                />
              );
              offset += frac;
              return el;
            })
          : null}
        <text x="70" y="66" textAnchor="middle" className="fill-gray-900" style={{ fontSize: 22, fontWeight: 700 }}>
          {total}
        </text>
        <text x="70" y="84" textAnchor="middle" className="fill-gray-400" style={{ fontSize: 10 }}>
          total
        </text>
      </svg>
      <ul className="grid w-full grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-1">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-gray-600">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
            <span className="font-semibold text-gray-900">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
