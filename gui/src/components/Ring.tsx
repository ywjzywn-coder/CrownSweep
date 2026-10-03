interface Props {
  /** 0-100 */
  value: number | undefined;
  size?: number;
  label?: string;
}

/** Ring gauge for the health score. */
export default function Ring({ value, size = 110, label }: Props) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = (v / 100) * c;
  const color = value == null ? "#92938f" : v >= 80 ? "#dfad78" : v >= 50 ? "#d9a62e" : "#e5534b";

  return (
    <div className="gauge-wrap">
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#40392f" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          opacity={value == null ? 0 : 1}
          strokeDasharray={c}
          strokeDashoffset={c - filled}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke 0.3s" }}
        />
        <text
          x="50%"
          y="52%"
          dominantBaseline="middle"
          textAnchor="middle"
          fill={color}
          fontSize={size * 0.26}
          fontWeight={500}
          fontFamily="-apple-system, sans-serif"
        >
          {value == null ? "—" : Math.round(v)}
        </text>
      </svg>
      {label && <div className="gauge-label">{label}</div>}
    </div>
  );
}
