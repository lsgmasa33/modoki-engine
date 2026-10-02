/** The project a state-changing request to the editor's child Vite was MEANT for (#1991).
 *
 *  Under the Electron editor, Vite is main's child (`electron/devServer.ts`, `MODOKI_VITE_UNDER_ELECTRON`), and every
 *  write goes to main's backend: the renderer is lint-forced onto `backendFetch`. The backend proxies the build-family
 *  streams (`backendServer.ts`) and main forwards a config invalidation here. Open Project moves Vite to the new project
 *  BEFORE it re-roots the backend (it installs and starts the new dev server first, `projectSwitch.ts`), and on a failed
 *  open Vite stays on the new project until `pairBack` restarts it. In that window, a proxied Build or Publish OTA from
 *  the old window ran on the NEW project. Also, the shared router mounted in Vite took writes with no switch gate at
 *  all.
 *
 *  So the backend STAMPS what it forwards with the root it serves, and Vite refuses a state-changing request whose
 *  stamp is missing or names another root. The check runs in the process that does the work, against the root it would
 *  use, so a race between a check in main and a forward cannot get around it. Reads (GET/HEAD/OPTIONS) pass: since
 *  #1967 no GET changes state. The stamp is not authentication (anything local can send it); it is the project
 *  identity the switch gate cannot otherwise see. A standalone `npm run dev` (no marker) is its own only writer, and is
 *  left alone. */

import { samePath } from '../../scripts/pathIdentity.mjs';

export const PROJECT_ROOT_HEADER = 'x-modoki-project-root';

/** The header value for `root`. Encoded because Node refuses a header value outside latin1 (`ERR_INVALID_CHAR`), so a
 *  project under a non-ASCII path would have turned every proxied build into a 502. */
export function projectStamp(root: string): string {
  return encodeURIComponent(root);
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface StampRefusal { status: 409; body: { ok: false; reason: 'project-stamp'; error: string } }

/** The refusal for this request, or null. `underElectron`: this Vite is the Electron editor's child. */
export function stampRefusal(req: { method?: string; url?: string; stamp: string | string[] | undefined }, ownRoot: string, underElectron: boolean): StampRefusal | null {
  if (!underElectron || READS.has((req.method ?? 'GET').toUpperCase())) return null;
  const route = (req.url ?? '').split('?')[0];
  const refuse = (error: string): StampRefusal => ({ status: 409, body: { ok: false, reason: 'project-stamp', error } });
  const raw = Array.isArray(req.stamp) ? req.stamp[0] : req.stamp;
  if (!raw) {
    return refuse(`${req.method} ${route} reached the editor's dev server directly, and it takes writes only from the editor's `
      + `backend, which knows which project is open. Send it to the backend port instead (GET /api/identity names it).`);
  }
  let stamped: string;
  try { stamped = decodeURIComponent(raw); } catch { stamped = raw; }
  if (!samePath(stamped, ownRoot)) {
    return refuse(`${req.method} ${route} was meant for ${stamped}, but this dev server now serves ${ownRoot}: the editor is `
      + 'switching project. Nothing ran. Retry once the project has loaded.');
  }
  return null;
}
