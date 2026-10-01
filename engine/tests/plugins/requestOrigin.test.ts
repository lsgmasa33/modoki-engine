// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isForeignOrigin, isForeignHost, foreignRequestRefusal } from '../../plugins/backend/requestOrigin';

/** #1648 S3: the rule both hosts share. The wiring is tested over real HTTP in electron/foreignOriginGate.test.ts and
 *  through the real Vite middleware in plugins/viteForeignOriginGate.test.ts. */
describe('isForeignOrigin', () => {
  const own = { ports: [5183], origins: ['http://127.0.0.1:5174'] };

  it('an ABSENT Origin is not foreign — curl, the MCP server and Node send none', () => {
    expect(isForeignOrigin(undefined, own)).toBe(false);
    expect(isForeignOrigin('', own)).toBe(false);
  });

  it.each(['http://127.0.0.1:5183', 'http://localhost:5183', 'http://[::1]:5183'])(
    'a loopback host on an own port (%s) is own', (o) => { expect(isForeignOrigin(o, own)).toBe(false); });

  it('an exact own origin is own, and the header may arrive as an array', () => {
    expect(isForeignOrigin('http://127.0.0.1:5174', own)).toBe(false);
    expect(isForeignOrigin(['http://127.0.0.1:5174'], own)).toBe(false);
  });

  it.each([
    ['a public site', 'https://evil.example'],
    ['DNS rebinding: a foreign NAME on our own port', 'http://evil.example:5183'],
    ['a loopback host on ANOTHER port (another clone, another local app)', 'http://127.0.0.1:5999'],
    ['an opaque origin (sandboxed frame, data:, file:)', 'null'],
    ['a non-http scheme', 'chrome-extension://abcdef'],
    ['garbage', '::not a url::'],
  ])('%s is foreign', (_why, o) => { expect(isForeignOrigin(o, own)).toBe(true); });

  it('a default port is matched as 80/443, not as "no port"', () => {
    expect(isForeignOrigin('http://localhost', { ports: [80] })).toBe(false);
    expect(isForeignOrigin('http://localhost', { ports: [5183] })).toBe(true);
  });
});

describe('isForeignHost (the Electron backend\'s DNS-rebinding defence)', () => {
  it.each(['127.0.0.1:5183', 'localhost:5183', 'LOCALHOST:5183', '[::1]:5183', 'localhost', undefined, ''])(
    '%s is not foreign (absent Host: only a non-browser client can omit it)', (h) => { expect(isForeignHost(h)).toBe(false); });
  it.each(['evil.example:5183', 'evil.example', '192.168.1.20:5183', '127.0.0.1.evil.example:5183'])(
    '%s is foreign', (h) => { expect(isForeignHost(h)).toBe(true); });
});

describe('foreignRequestRefusal — the verdict both hosts act on', () => {
  const own = { ports: [5183], origins: ['http://127.0.0.1:5174'] };
  const refused = (h: Record<string, string>, checkHost = false) => foreignRequestRefusal(h, own, { checkHost }) !== null;

  it('a cross-site request with NO Origin (an <img src>, a navigation) is refused', () => {
    expect(refused({ 'sec-fetch-site': 'cross-site' })).toBe(true);
  });
  it.each(['same-origin', 'same-site', 'none'])('Sec-Fetch-Site: %s with no Origin passes', (v) => {
    expect(refused({ 'sec-fetch-site': v })).toBe(false);
  });
  it('no Origin and no Sec-Fetch-Site (curl, MCP, Node) passes', () => { expect(refused({})).toBe(false); });
  it('an OWN Origin passes even when the request is cross-site', () => {
    expect(refused({ origin: 'http://127.0.0.1:5174', 'sec-fetch-site': 'cross-site' })).toBe(false);
  });
  it('a FOREIGN Origin is refused even when Sec-Fetch-Site says same-site', () => {
    expect(refused({ origin: 'https://evil.example', 'sec-fetch-site': 'same-site' })).toBe(true);
  });
  it('a rebinding Host is refused only where the host asks for the Host check', () => {
    expect(refused({ host: 'evil.example:5183' }, true)).toBe(true);
    expect(refused({ host: 'evil.example:5183' }, false)).toBe(false);
  });
});
