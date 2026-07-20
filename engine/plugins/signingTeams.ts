/** Discover the Apple developer *teams* usable for iOS signing on this machine,
 *  so the editor can offer a "Nomura Masaki (KQ6FQ2BS8H)" dropdown instead of a
 *  raw 10-char Team ID text box, and the build can turn Xcode's cryptic
 *  "No Account for Team X" into an actionable list.
 *
 *  Two sources, unioned + deduped by the 10-char Team ID:
 *   - **Installed provisioning profiles** (~/Library/.../Provisioning Profiles):
 *     each embeds TeamName + TeamIdentifier — the strongest signal a team was
 *     actually provisioned here (`hasProfile`).
 *   - **Code-signing identities** (`security find-identity`): the cert CN carries
 *     the team name + its OU is a team id. NOTE these are keychain certs, which
 *     can outlive a signed-in account — a cert-only team may still fail to build
 *     ("No Account"). So a team's presence here is discovery, NOT a guarantee.
 *
 *  The parsing is split from the shell IO so it's unit-testable without a mac. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface SigningTeam {
  /** 10-char Apple Team ID — the value written to DEVELOPMENT_TEAM. */
  id: string;
  /** Human team name (e.g. "Nomura Masaki") — for display only. */
  name: string;
  /** Where we found it: a provisioning profile and/or a signing cert. */
  sources: ('profile' | 'cert')[];
  /** True if an installed provisioning profile references this team (a stronger
   *  "usable here" hint than a cert alone). */
  hasProfile: boolean;
}

/** Pull TeamName + TeamIdentifier out of a decoded (XML plist) provisioning
 *  profile. Returns null when the shape doesn't match. */
export function parseProvisioningPlist(xml: string): { id: string; name: string } | null {
  const name = xml.match(/<key>TeamName<\/key>\s*<string>([^<]*)<\/string>/)?.[1]?.trim();
  const id = xml.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1]?.trim();
  if (!id) return null;
  return { id, name: name || id };
}

/** Parse `security find-identity -v -p codesigning` output into team {id,name}.
 *  Lines look like: `  2) ABC…DEF "Apple Development: Nomura Masaki (R8UF373395)"`.
 *  Only development/distribution identities carry a usable team id in parens. */
export function parseSigningIdentities(output: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const re = /"(?:Apple Development|iPhone Developer|Apple Distribution|iPhone Distribution): (.+?) \(([A-Z0-9]{10})\)"/g;
  for (const m of output.matchAll(re)) out.push({ name: m[1].trim(), id: m[2] });
  return out;
}

/** The two dirs Xcode keeps managed + manually-installed profiles in. */
function provisioningDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
    path.join(home, 'Library', 'MobileDevice', 'Provisioning Profiles'),
  ];
}

/** Merge a discovered team into the map (dedup by id, union sources). */
function upsert(map: Map<string, SigningTeam>, id: string, name: string, source: 'profile' | 'cert') {
  const existing = map.get(id);
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (source === 'profile') existing.hasProfile = true;
    // Prefer a non-id display name if we didn't have one yet.
    if ((existing.name === id || !existing.name) && name && name !== id) existing.name = name;
    return;
  }
  map.set(id, { id, name: name || id, sources: [source], hasProfile: source === 'profile' });
}

/** Discover signing teams on this machine (macOS only — returns [] elsewhere or
 *  on any tooling error). Never throws: discovery is best-effort. */
export function discoverSigningTeams(): SigningTeam[] {
  if (process.platform !== 'darwin') return [];
  const teams = new Map<string, SigningTeam>();

  // 1) Provisioning profiles — decode each with `security cms -D`.
  for (const dir of provisioningDirs()) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.mobileprovision') || f.endsWith('.provisionprofile'));
    } catch { continue; } // dir missing → skip
    for (const f of files) {
      try {
        const xml = execFileSync('security', ['cms', '-D', '-i', path.join(dir, f)], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
        });
        const t = parseProvisioningPlist(xml);
        if (t) upsert(teams, t.id, t.name, 'profile');
      } catch { /* unreadable/expired profile — skip */ }
    }
  }

  // 2) Code-signing identities.
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024,
    });
    for (const t of parseSigningIdentities(out)) upsert(teams, t.id, t.name, 'cert');
  } catch { /* no identities / security unavailable */ }

  // Profiles first (more likely usable), then by name for stable ordering.
  return [...teams.values()].sort((a, b) =>
    Number(b.hasProfile) - Number(a.hasProfile) || a.name.localeCompare(b.name));
}
