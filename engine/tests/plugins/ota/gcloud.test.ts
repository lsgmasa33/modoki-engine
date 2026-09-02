/** Classifying `gcloud storage` failures for the OTA publish pipeline (docs/ota-updates.md). */
import { describe, it, expect } from 'vitest';
import { isGcloudObjectNotFoundError } from '../../../scripts/ota/gcloud.mjs';

describe('isGcloudObjectNotFoundError (version-collision preflight)', () => {
  it('recognizes the "not found: 404" form (gcloud storage cat on a missing object)', () => {
    expect(isGcloudObjectNotFoundError('ERROR: (gcloud.storage.cat) gs://bucket/x not found: 404.')).toBe(true);
  });

  it('recognizes the "matched no objects or files" form', () => {
    expect(isGcloudObjectNotFoundError('ERROR: (gcloud.storage.cat) The following URLs matched no objects or files:\ngs://bucket/x')).toBe(true);
  });

  it('does NOT treat an auth/network error as "not found" — the ambiguity fix', () => {
    // Before this fix, ANY gcloud failure (including these) was silently treated as "no
    // collision, proceed" — letting a publish past the guard meant to catch a version a
    // device already rejected. See ota-updates.md's Gotchas.
    expect(isGcloudObjectNotFoundError('ERROR: You do not currently have an active account selected.')).toBe(false);
    expect(isGcloudObjectNotFoundError('ERROR: (gcloud.storage.cat) HTTPError 403: Permission denied')).toBe(false);
    expect(isGcloudObjectNotFoundError('')).toBe(false);
  });

  it('does NOT treat a permissions/network-shaped error containing neither phrase as "not found"', () => {
    expect(isGcloudObjectNotFoundError('ERROR: (gcloud.storage.cat) AccessDeniedException: 403 caller does not have storage.objects.get access')).toBe(false);
  });
});
