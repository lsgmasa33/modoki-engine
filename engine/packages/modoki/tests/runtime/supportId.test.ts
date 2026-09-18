/** `supportId` (#1398): which ID a Settings "Player ID" row shows. The owner's ruling is the table
 *  below: the account uid wins while signed in, the app-instance ID stands in when signed out, and
 *  with neither the row says so instead of copying nothing. */
import { describe, expect, it } from 'vitest';
import { supportId, supportIdView } from '../../src/runtime/account';

describe('supportId', () => {
  it('shows the account uid when signed in, even though an app-instance ID also exists', () => {
    expect(supportId('uid-abc', 'inst-123')).toEqual({ kind: 'account', id: 'uid-abc' });
  });

  it('falls back to the app-instance ID when signed out', () => {
    expect(supportId(null, 'inst-123')).toEqual({ kind: 'install', id: 'inst-123' });
    expect(supportId(undefined, 'inst-123')).toEqual({ kind: 'install', id: 'inst-123' });
  });

  // Consent denied (ANALYTICS_STORAGE) or off-native: Firebase has no instance ID to give.
  it('is `none` with neither, rather than an empty ID a Copy button would copy', () => {
    expect(supportId(null, undefined)).toEqual({ kind: 'none' });
    expect(supportId('', '')).toEqual({ kind: 'none' });
    expect(supportId('  ', null)).toEqual({ kind: 'none' });
  });

  it('shows the whole value, never a shortened one', () => {
    const long = 'x'.repeat(64);
    expect(supportId(long, null)).toEqual({ kind: 'account', id: long });
  });
});

const words = { copy: 'Copy', copied: 'Copied', failed: 'Failed', unavailable: 'Not available' };
const UID = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9t';

describe('supportIdView', () => {
  it('shows the whole ID and an idle Copy button', () => {
    expect(supportIdView({ kind: 'account', id: UID }, words, null, 0)).toEqual({ value: UID, button: 'Copy', buttonVisible: true });
    expect(supportIdView({ kind: 'install', id: 'f00d' }, words, null, 0).value).toBe('f00d');
  });

  it('says Copied, or Failed, only inside the feedback window, and reverts after it', () => {
    const id = { kind: 'account', id: UID } as const;
    expect(supportIdView(id, words, { copied: true, until: 1500 }, 1499).button).toBe('Copied');
    expect(supportIdView(id, words, { copied: false, until: 1500 }, 1499).button).toBe('Failed');
    expect(supportIdView(id, words, { copied: true, until: 1500 }, 1500).button).toBe('Copy');
  });

  it('with no ID, shows the unavailable line and HIDES Copy rather than offering a copy of nothing', () => {
    expect(supportIdView({ kind: 'none' }, words, { copied: true, until: 99 }, 0)).toEqual({ value: 'Not available', button: 'Copy', buttonVisible: false });
  });
});
