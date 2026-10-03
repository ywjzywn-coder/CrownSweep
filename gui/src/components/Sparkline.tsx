import { useEffect, useRef } from "react";

interface Props {
  values: number[];
  color?: string;
  height?: number;
  /** 0-100, max for scaling; defaults to max(values, 100) */
  scaleMax?: number;
  /** optional second series drawn underneath in another color */
  values2?: number[];
  color2?: string;
}

/** Rolling sparkline drawn on a canvas. Zero deps; redraws on data change
 *  AND on container resize (window resize used to leave a stretched bitmap). */
export default function Sparkline({
  values,
  color = "#e8a04c",
  height = 56,
  scaleMax,
  values2,
  color2 = "#539bf5",
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef<Required<Props>>({
    values,
    color,
    height,
    scaleMax: scaleMax ?? 100,
    values2: values2 ?? [],
    color2,
  });
  propsRef.current = { values, color, height, scaleMax: scaleMax ?? 100, values2: values2 ?? [], color2 };
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const p = propsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = p.height;
      if (w < 4 || h < 4) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const paint = (vals: number[], col: string, fill: boolean) => {
        if (vals.length < 2) return;
        const max = Math.max(p.scaleMax ?? 100, ...p.values, ...(p.values2 ?? []), 1);
        const step = w / (vals.length - 1);
        const y = (v: number) => h - 2 - (Math.min(v, max) / max) * (h - 6);
        if (fill) {
          ctx.beginPath();
          ctx.moveTo(0, h);
          vals.forEach((v, i) => ctx.lineTo(i * step, y(v)));
          ctx.lineTo(w, h);
          ctx.closePath();
          const grad = ctx.createLinearGradient(0, 0, 0, h);
          grad.addColorStop(0, col + "44");
          grad.addColorStop(1, col + "05");
          ctx.fillStyle = grad;
          ctx.fill();
        }
        ctx.beginPath();
        vals.forEach((v, i) => {
          const px = i * step;
          const py = y(v);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = "round";
        ctx.stroke();
        const lx = (vals.length - 1) * step;
        const ly = y(vals[vals.length - 1]);
        ctx.beginPath();
        ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
      };

      if (p.values2 && p.values2.length >= 2) paint(p.values2, p.color2, false);
      paint(p.values, p.color, true);
    };
    drawRef.current = draw;
    draw();

    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Data changed: repaint with the latest props.
  useEffect(() => {
    drawRef.current();
  });

  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />;
}
