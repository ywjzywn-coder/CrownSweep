import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

// Only queue the currently displayed page. In-flight requests may finish after
// a page change, but the shared pool never exceeds four native icon requests.
export function useAppIcons(paths: readonly string[]) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const cache = useRef<Record<string, string>>({});
  const failed = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const mounted = useRef(false);
  const drainRef = useRef<() => void>(() => {});

  const drain = useCallback(() => {
    if (!mounted.current) return;
    while (active.current < 4 && queue.current.length > 0) {
      const path = queue.current.shift()!;
      if (!path || cache.current[path] || failed.current.has(path) || pending.current.has(path)) continue;
      pending.current.add(path);
      active.current += 1;
      void api.appIcon(path)
        .then((icon) => {
          if (!icon) { failed.current.add(path); return; }
          cache.current[path] = icon;
          if (mounted.current) setIcons((previous) => ({ ...previous, [path]: icon }));
        })
        .catch(() => { failed.current.add(path); })
        .finally(() => {
          pending.current.delete(path);
          active.current -= 1;
          drainRef.current();
        });
    }
  }, []);
  drainRef.current = drain;

  useEffect(() => {
    mounted.current = true;
    drain();
    return () => { mounted.current = false; queue.current = []; };
  }, [drain]);

  useEffect(() => {
    queue.current = [...new Set(paths)].filter((path) => path && !cache.current[path] && !failed.current.has(path) && !pending.current.has(path));
    drain();
  }, [paths, drain]);

  return icons;
}
