import { useCallback, useEffect, useState } from 'react';

/** localStorage-backed set of expanded-folder keys for a collapsible tree.
 *  Shared by the read-only Assets-panel trees (Engine section, Scripts tree) so
 *  the load → persist → toggle → expand/collapse-all boilerplate lives in one
 *  place. The interactive project FolderView keeps its own bespoke state (it also
 *  reparents keys on folder rename/delete), so it deliberately does NOT use this. */
export function useExpandedSet(lsKey: string, defaults: string[] = []) {
  const [expanded, setExpanded] = useState<Set<string>>(() => load(lsKey, defaults));

  // Persist on every change (the same key seeds the next mount's default set).
  useEffect(() => {
    try { localStorage.setItem(lsKey, JSON.stringify([...expanded])); } catch { /* ignore */ }
  }, [lsKey, expanded]);

  /** Flip a single key open/closed. */
  const toggle = useCallback((key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);

  /** Expand or collapse a batch of keys together (Option/Alt-click "all"). The
   *  direction anchors on `anchor` (default `keys[0]`): if the anchor is currently
   *  open → collapse the batch, else expand it. */
  const toggleMany = useCallback((keys: string[], anchor: string = keys[0]) => setExpanded((prev) => {
    const expand = !prev.has(anchor);
    const next = new Set(prev);
    for (const k of keys) { if (expand) next.add(k); else next.delete(k); }
    return next;
  }), []);

  return { expanded, setExpanded, toggle, toggleMany };
}

function load(key: string, defaults: string[]): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set(defaults);
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set(defaults);
  } catch { return new Set(defaults); }
}
