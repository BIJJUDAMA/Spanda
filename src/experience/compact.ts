import { useEffect, useState } from 'react';

const COMPACT_QUERY = '(max-width: 760px), (max-height: 760px)';

export function useCompactHud() {
  const measure = () => typeof window !== 'undefined' &&
    (window.matchMedia?.(COMPACT_QUERY).matches ?? (window.innerWidth <= 760 || window.innerHeight <= 760));
  const [compact, setCompact] = useState(measure);
  useEffect(() => {
    const media = window.matchMedia?.(COMPACT_QUERY);
    const update = () => setCompact(measure());
    media?.addEventListener?.('change', update);
    window.addEventListener('resize', update);
    update();
    return () => {
      media?.removeEventListener?.('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return compact;
}
