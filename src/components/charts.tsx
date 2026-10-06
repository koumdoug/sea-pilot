import { cx } from "./ui";

// Graphiques SVG sans dépendance : lisibles, accessibles (role="img" + tableau équivalent), aucune donnée inventée.

const COLORS = ["#2554e0", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function LineChart({ title, labels, series, format = (n) => String(Math.round(n * 100) / 100), height = 200, integer = false }: {
  integer?: boolean;
  title: string; labels: string[]; series: { name: string; values: number[]; color?: string }[]; format?: (n: number) => string; height?: number;
}) {
  const W = 640, H = height, pl = 44, pr = 12, pt = 12, pb = 26;
  const n = labels.length;
  const max = niceMax(Math.max(integer ? 4 : 0, ...series.flatMap((s) => s.values)));
  const x = (i: number) => pl + (n <= 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (n - 1));
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const step = Math.max(1, Math.ceil(n / 6));
  const hasData = series.some((s) => s.values.some((v) => v > 0));
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 flex flex-wrap items-center gap-3 text-sm font-semibold text-ink">
        {title}
        {series.map((s, i) => <span key={s.name} className="flex items-center gap-1 text-xs font-normal text-slate-600"><span className="inline-block size-2.5 rounded-sm" style={{ background: s.color ?? COLORS[i % COLORS.length] }} />{s.name}</span>)}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title} : ${series.map((s) => `${s.name} de ${format(Math.min(...s.values))} à ${format(Math.max(...s.values))}`).join(" ; ")}`}>
        {ticks.map((t) => (
          <g key={t}><line x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth="1" /><text x={pl - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#64748b">{format(t)}</text></g>
        ))}
        {labels.map((l, i) => (i % step === 0 || i === n - 1) && <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#64748b">{l.slice(5)}</text>)}
        {series.map((s, si) => {
          const color = s.color ?? COLORS[si % COLORS.length];
          const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
              {n <= 45 && s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill={color}><title>{`${labels[i]} — ${s.name} : ${format(v)}`}</title></circle>)}
            </g>
          );
        })}
      </svg>
      {!hasData && <p className="text-xs text-slate-500">Aucune donnée sur la période.</p>}
      <table className="sr-only"><caption>{title}</caption><thead><tr><th>Date</th>{series.map((s) => <th key={s.name}>{s.name}</th>)}</tr></thead>
        <tbody>{labels.map((l, i) => <tr key={l}><td>{l}</td>{series.map((s) => <td key={s.name}>{format(s.values[i])}</td>)}</tr>)}</tbody></table>
    </figure>
  );
}

export function BarList({ title, rows, format = (n) => String(n), color = COLORS[0], empty = "Aucune donnée." }: {
  title: string; rows: { label: string; value: number; hint?: string }[]; format?: (n: number) => string; color?: string; empty?: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-semibold text-ink">{title}</figcaption>
      {rows.length === 0 ? <p className="text-sm text-slate-500">{empty}</p> : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="flex items-baseline justify-between gap-2 text-sm"><span className="min-w-0 truncate" title={r.label}>{r.label}</span><span className="shrink-0 tabular-nums font-medium">{format(r.value)}{r.hint && <span className="ml-1 text-xs font-normal text-slate-500">{r.hint}</span>}</span></div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true"><div className="h-full rounded-full" style={{ width: `${max > 0 ? Math.max(2, (r.value / max) * 100) : 0}%`, background: color }} /></div>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

export function Funnel({ steps, className }: { steps: { label: string; value: number }[]; className?: string }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <ol className={cx("space-y-2", className)} aria-label="Entonnoir de conversion">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].value : null;
        const rate = prev && prev > 0 ? `${((s.value / prev) * 100).toFixed(1)} % de l'étape précédente` : null;
        return (
          <li key={s.label}>
            <div className="flex items-baseline justify-between text-sm"><span>{s.label}</span><span className="tabular-nums font-semibold">{new Intl.NumberFormat("fr-FR").format(s.value)}</span></div>
            <div className="mt-1 h-3 overflow-hidden rounded bg-slate-100" aria-hidden="true"><div className="h-full rounded" style={{ width: `${Math.max(s.value > 0 ? 2 : 0, (s.value / max) * 100)}%`, background: COLORS[0], opacity: 1 - i * 0.12 }} /></div>
            {rate && <p className="mt-0.5 text-xs text-slate-500">{rate}</p>}
          </li>
        );
      })}
    </ol>
  );
}
