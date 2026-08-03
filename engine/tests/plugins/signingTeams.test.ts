import { describe, it, expect } from 'vitest';
import { parseProvisioningPlist, parseSigningIdentities } from '../../plugins/signingTeams';

describe('parseProvisioningPlist', () => {
  const wrap = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}</dict></plist>`;

  it('extracts TeamName + TeamIdentifier', () => {
    const xml = wrap(`
      <key>TeamName</key><string>Example Team</string>
      <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
    `);
    expect(parseProvisioningPlist(xml)).toEqual({ id: 'ABCDE12345', name: 'Example Team' });
  });

  it('falls back to the id as name when TeamName is absent', () => {
    const xml = wrap(`<key>TeamIdentifier</key><array><string>FGHIJ67890</string></array>`);
    expect(parseProvisioningPlist(xml)).toEqual({ id: 'FGHIJ67890', name: 'FGHIJ67890' });
  });

  it('returns null without a TeamIdentifier', () => {
    expect(parseProvisioningPlist(wrap(`<key>TeamName</key><string>x</string>`))).toBeNull();
    expect(parseProvisioningPlist('not a plist')).toBeNull();
  });
});

describe('parseSigningIdentities', () => {
  it('parses name + 10-char team id from Apple Development / Distribution lines', () => {
    const out = [
      '  1) ED3D…CB26 "Developer ID Application: Example Team (ABCDE12345)"', // ignored (not dev/dist)
      '  2) A9EE…5562 "Apple Development: Example Team (KLMNO13579)"',
      '  3) 7EDC…88A1 "Apple Development: Second Team (PQRST24680)"',
      '  4) BEEF…F00D "Apple Distribution: Acme Inc (ABCDE12345)"',
      '     4 valid identities found',
    ].join('\n');
    expect(parseSigningIdentities(out)).toEqual([
      { name: 'Example Team', id: 'KLMNO13579' },
      { name: 'Second Team', id: 'PQRST24680' },
      { name: 'Acme Inc', id: 'ABCDE12345' },
    ]);
  });

  it('returns [] when there are no matching identities', () => {
    expect(parseSigningIdentities('  0 valid identities found')).toEqual([]);
  });
});
