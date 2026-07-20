import { describe, it, expect } from 'vitest';
import { parseProvisioningPlist, parseSigningIdentities } from '../../plugins/signingTeams';

describe('parseProvisioningPlist', () => {
  const wrap = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}</dict></plist>`;

  it('extracts TeamName + TeamIdentifier', () => {
    const xml = wrap(`
      <key>TeamName</key><string>Nomura Masaki</string>
      <key>TeamIdentifier</key><array><string>KQ6FQ2BS8H</string></array>
    `);
    expect(parseProvisioningPlist(xml)).toEqual({ id: 'KQ6FQ2BS8H', name: 'Nomura Masaki' });
  });

  it('falls back to the id as name when TeamName is absent', () => {
    const xml = wrap(`<key>TeamIdentifier</key><array><string>B7CXPY2UEP</string></array>`);
    expect(parseProvisioningPlist(xml)).toEqual({ id: 'B7CXPY2UEP', name: 'B7CXPY2UEP' });
  });

  it('returns null without a TeamIdentifier', () => {
    expect(parseProvisioningPlist(wrap(`<key>TeamName</key><string>x</string>`))).toBeNull();
    expect(parseProvisioningPlist('not a plist')).toBeNull();
  });
});

describe('parseSigningIdentities', () => {
  it('parses name + 10-char team id from Apple Development / Distribution lines', () => {
    const out = [
      '  1) ED3D…CB26 "Developer ID Application: Nomura Masaki (KQ6FQ2BS8H)"', // ignored (not dev/dist)
      '  2) A9EE…5562 "Apple Development: Nomura Masaki (R8UF373395)"',
      '  3) 7EDC…88A1 "Apple Development: Masaki Nomura (37L6792N3W)"',
      '  4) BEEF…F00D "Apple Distribution: Acme Inc (ABCDE12345)"',
      '     4 valid identities found',
    ].join('\n');
    expect(parseSigningIdentities(out)).toEqual([
      { name: 'Nomura Masaki', id: 'R8UF373395' },
      { name: 'Masaki Nomura', id: '37L6792N3W' },
      { name: 'Acme Inc', id: 'ABCDE12345' },
    ]);
  });

  it('returns [] when there are no matching identities', () => {
    expect(parseSigningIdentities('  0 valid identities found')).toEqual([]);
  });
});
