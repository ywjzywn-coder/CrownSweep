// Minimal stroke icon set (feather/lucide-flavoured), inherits currentColor.
import type { SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconGauge(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.9 19a9 9 0 1 1 14.2 0" />
      <path d="M12 13.5 15.5 9" />
      <circle cx="12" cy="14" r="1.2" />
    </Svg>
  );
}

export function IconSparkles(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M11 4.5l1.4 3.6 3.6 1.4-3.6 1.4L11 14.5 9.6 10.9 6 9.5l3.6-1.4L11 4.5z" />
      <path d="M18.5 13.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
    </Svg>
  );
}

export function IconBox(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 8.2 12 3 3 8.2v7.6L12 21l9-5.2V8.2z" />
      <path d="M3.4 8.3 12 13.2l8.6-4.9" />
      <path d="M12 21v-7.8" />
    </Svg>
  );
}

export function IconPie(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21.2 15.9A10 10 0 1 1 8.1 2.8" />
      <path d="M22 12A10 10 0 0 0 12 2v10z" />
    </Svg>
  );
}

export function IconBolt(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13 2 3 14h8l-1 8 11-12h-8l1-8z" />
    </Svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </Svg>
  );
}

export function IconSliders(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="7" cy="18" r="2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  );
}

export function IconDownload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v11" />
      <path d="M7.5 10 12 14.5 16.5 10" />
      <path d="M4 17.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2.5" />
    </Svg>
  );
}

export function IconUpload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 14V3" />
      <path d="M7.5 7.5 12 3l4.5 4.5" />
      <path d="M4 17.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2.5" />
    </Svg>
  );
}

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 4.5v15l13-7.5-13-7.5z" />
    </Svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.5-4.5" />
    </Svg>
  );
}

export function IconFolder(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </Svg>
  );
}

export function IconFile(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 2.5H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5l-6-6z" />
      <path d="M14 2.5v6h6" />
    </Svg>
  );
}

export function IconReveal(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 3.5h6.5V10" />
      <path d="M20.5 3.5 12 12" />
      <path d="M20 14v5.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h5.5" />
    </Svg>
  );
}

export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="M6.5 7 7.4 20a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7" />
    </Svg>
  );
}

export function IconGlobe(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </Svg>
  );
}

export function IconCpu(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <rect x="10" y="10" width="4" height="4" />
      <path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3" />
    </Svg>
  );
}

export function IconTerminal(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 17.5 10 12 4 6.5" />
      <path d="M12.5 19h7.5" />
    </Svg>
  );
}

/** Brand mark: mole popping out of a hole (filled). */
export function MoleLogo({ size = 30 }: { size?: number }) {
  return <img src="/mole-icon.png" width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
