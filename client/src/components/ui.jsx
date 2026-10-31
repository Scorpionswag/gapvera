import { STATUS_COLORS, scoreColor } from "../api.js";

export function StatCard({ label, value, sub }) {
  return (
    <div className="glass p-4 relative overflow-hidden">
      <div className="absolute inset-y-3 left-0 w-px bg-gradient-to-b from-ember/70 via-ember/25 to-transparent" />
      <div className="micro">{label}</div>
      <div className="numeral text-3xl mt-1">{value}</div>
      {sub && <div className="text-xs text-dim mt-1">{sub}</div>}
    </div>
  );
}

export function Badge({ children }) {
  const cls = STATUS_COLORS[children] || "bg-dim/10 text-dim border-dim/30";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {children}
    </span>
  );
}

export function Score({ value }) {
  return <span className={`numeral font-semibold ${scoreColor(value)}`}>{value}</span>;
}

export function ScoreRing({ value, size = 96 }) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <defs>
        <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#c24b2e" />
          <stop offset="100%" stopColor="#e59374" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(230,233,237,0.08)" strokeWidth="5" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="url(#ringGrad)" strokeWidth="5" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ filter: "drop-shadow(0 0 6px rgba(194,75,46,0.5))", transition: "stroke-dashoffset 700ms ease" }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
        fill="#e6e9ed" fontFamily="Fraunces, Georgia, serif" fontSize={size * 0.3} fontWeight="500">
        {value}
      </text>
    </svg>
  );
}

export function Stars({ rating }) {
  if (!rating) return <span className="text-dim/60">-</span>;
  return (
    <span className="text-ember">
      {"★".repeat(Math.round(rating))}
      <span className="text-dim ml-1 text-xs">{rating}</span>
    </span>
  );
}

export function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 md:p-10" onClick={onClose}>
      <div
        className={`glass w-full ${wide ? "max-w-3xl" : "max-w-xl"} p-5 mt-4`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-xl font-medium">{title}</h2>
          <button className="btn-ghost !px-2 !py-1" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

export function SortHeader({ label, field, sort, setSort }) {
  const active = sort.field === field;
  return (
    <th
      className={`th cursor-pointer hover:text-ink ${active ? "!text-ember" : ""}`}
      onClick={() =>
        setSort({ field, dir: active && sort.dir === "desc" ? "asc" : "desc" })
      }
    >
      {label} {active ? (sort.dir === "desc" ? "▾" : "▴") : ""}
    </th>
  );
}

export function sortRows(rows, sort) {
  return [...rows].sort((a, b) => {
    const av = a[sort.field] ?? "";
    const bv = b[sort.field] ?? "";
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return sort.dir === "desc" ? -cmp : cmp;
  });
}
