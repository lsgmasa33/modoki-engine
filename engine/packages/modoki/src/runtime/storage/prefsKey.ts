/** The PlayerPrefs full-key format, `mk:<namespace>:<logical>` — the ONE place that knows it.
 *
 *  Dependency-free on purpose: besides `playerPrefs.ts` and the storage backends, the gameplay
 *  recorder (#1479) reads keys out of the editor's store and its Node CLI writes them back under the
 *  runtime namespace. A copy of this format in either would restore nothing, silently, the day the
 *  format changed. */

/** The root every PlayerPrefs full key starts with. The backend migration moves exactly these and
 *  nothing else a game may keep in the same store. */
export const PREFS_KEY_ROOT = 'mk:';

/** Keep the `mk:<ns>:` delimiter unambiguous — collapse any ':' in the namespace. */
export function sanitizeNamespace(ns: string): string {
  return ns.replace(/:/g, '_') || 'default';
}

/** The prefix of every full key in an ALREADY-SANITISED namespace. */
export function prefixFor(ns: string): string {
  return `${PREFS_KEY_ROOT}${ns}:`;
}

/** The prefix of every full key in `namespace` as a caller names it (sanitised here). */
export function prefsKeyPrefix(namespace: string): string {
  return prefixFor(sanitizeNamespace(namespace));
}
