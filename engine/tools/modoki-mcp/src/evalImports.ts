/** `modoki_eval`'s second-module-instance warning (#1155). Pure — the tool supplies the lookup.
 *
 *  An eval body is not served through Vite, so its `import('…')` goes to the browser exactly as
 *  written, and the browser keys module instances by URL string. Any spelling other than the one
 *  the app imported evaluates the module a second time: its module-level state is a fresh copy the
 *  app never reads or writes. Which spelling is canonical is Vite's module graph's answer
 *  (`/api/module-url`, `engine/plugins/backend/moduleUrl.ts`), not a prefix rule — a game file is
 *  canonical AT `/@fs/…`.
 *
 *  A WARNING, not a refusal (decided on #1155): importing a pure helper or a constant through a
 *  second copy is harmless, and a specifier built at runtime cannot be seen here at all, so a
 *  refusal would claim a guarantee this cannot give. */

/** How many distinct specs one eval is checked for — each costs a round trip. */
export const MAX_CHECKED_IMPORTS = 8;

/** Module URLs a body imports through a LITERAL string. Only URL-shaped specs (`/…`, `http(s)://…`)
 *  count: a bare specifier (`'three'`) does not resolve in the browser at all, and a template
 *  literal with `${…}` is a runtime value this cannot know. */
export function literalImportSpecs(code: string): string[] {
  const out = new Set<string>();
  // Not after `.`/an identifier char: `modoki.import('/@fs/…')` is the sanctioned route itself, and
  // warning on it would tell the reader to replace the fix with the fix (caught live, #1155).
  const re = /(?<![.\w$])import\s*\(\s*(['"`])([^'"`$\\\n]+)\1\s*[,)]/g;
  for (let m = re.exec(code); m && out.size < MAX_CHECKED_IMPORTS; m = re.exec(code)) {
    const spec = m[2].trim();
    if ((spec.startsWith('/') && !spec.startsWith('//')) || /^https?:\/\//i.test(spec)) out.add(spec);
  }
  return [...out];
}

export interface ModuleUrlAnswer {
  url: string;
  file: string;
  inGraph: boolean;
}

/** The URL as the browser keys it, minus an origin — `http://127.0.0.1:5177/x.ts` and `/x.ts` are
 *  the same module on the page that loaded both. */
function withoutOrigin(spec: string): string {
  if (!/^https?:\/\//i.test(spec)) return spec;
  try { const u = new URL(spec); return u.pathname + u.search; } catch { return spec; }
}

/** Percent-escapes decoded, as the browser's module map compares them: `/@fs/C:/Users/John%20Doe/x.ts`
 *  and the graph's decoded `/@fs/C:/Users/John Doe/x.ts` are one module. */
function sameModuleUrl(a: string, b: string): boolean {
  const dec = (s: string) => { try { return decodeURI(s); } catch { return s; } };
  return dec(a) === dec(b);
}

/** The warning for one literal import, or null when it reaches the app's instance — or when the
 *  app has no instance of that file, so there is nothing for a second copy to disagree with. */
export function secondInstanceWarning(spec: string, answer: ModuleUrlAnswer): string | null {
  if (!answer.inGraph || sameModuleUrl(withoutOrigin(spec), answer.url)) return null;
  // "imports", not "loaded": the check reads the code's TEXT, so a literal in a comment or a string
  // matches without anything having been loaded.
  return `import('${spec}') imports a SECOND instance of ${answer.file} — the app's is '${answer.url}'. `
    + 'Module-level state read or written through it is NOT the app\'s (a symbol re-exported from '
    + 'another module can still look shared). Use `await modoki.import(\'' + spec + '\')` instead.';
}
