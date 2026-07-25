/** OtaKeysDialog (OTA Phase 5a, docs/ota-updates.md) had ZERO test coverage. This is the
 *  ONLY UI surface for generating the OTA signing keypair — losing/mishandling it means
 *  every installed binary can never be updated again, so the two properties that matter
 *  are: (1) it never lets you "regenerate" an existing key (the backend already refuses,
 *  this just needs to keep that refusal visible/enforced client-side too), and (2) the
 *  mismatch banner correctly detects when the generated key and Project Settings'
 *  ota.publicKey have drifted apart. */
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  backendFetch: vi.fn(),
  backendPostJson: vi.fn(),
}));

vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: h.backendFetch,
  backendPostJson: h.backendPostJson,
}));

import OtaKeysDialog from '../../src/editor/panels/OtaKeysDialog';
import { useEditorStore } from '../../src/editor/store/editorStore';

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useEditorStore.setState({ otaKeysOpen: false });
});

describe('OtaKeysDialog', () => {
  it('renders nothing when closed', () => {
    useEditorStore.setState({ otaKeysOpen: false });
    const { container } = render(<OtaKeysDialog />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "no key yet" and an enabled Generate button when none exists', async () => {
    h.backendFetch.mockImplementation(async (path: string) =>
      path.startsWith('/api/ota/keys') ? jsonResponse({ ok: true, exists: false, publicKey: null }) : jsonResponse({ ota: {} }));
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText(/No key generated yet/));
    const generateBtn = getByText('Generate') as HTMLButtonElement;
    expect(generateBtn.disabled).toBe(false);
  });

  it('disables Generate once a key exists — no client-side path to "regenerate"', async () => {
    h.backendFetch.mockImplementation(async (path: string) =>
      path.startsWith('/api/ota/keys')
        ? jsonResponse({ ok: true, exists: true, publicKey: 'pk-abc' })
        : jsonResponse({ ota: { publicKey: 'pk-abc' } }));
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText(/Key "default" exists/));
    const generateBtn = getByText('Generate') as HTMLButtonElement;
    expect(generateBtn.disabled).toBe(true);
  });

  it('shows a mismatch warning + Sync button when the generated key differs from Project Settings', async () => {
    h.backendFetch.mockImplementation(async (path: string) =>
      path.startsWith('/api/ota/keys')
        ? jsonResponse({ ok: true, exists: true, publicKey: 'pk-new' })
        : jsonResponse({ ota: { publicKey: 'pk-old' } }));
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText(/does not match this key/));
    expect(() => getByText('Sync to Project Settings')).not.toThrow();
  });

  it('does NOT show a mismatch warning once the keys match', async () => {
    h.backendFetch.mockImplementation(async (path: string) =>
      path.startsWith('/api/ota/keys')
        ? jsonResponse({ ok: true, exists: true, publicKey: 'pk-same' })
        : jsonResponse({ ota: { publicKey: 'pk-same' } }));
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText, queryByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText(/Matches Project Settings/));
    expect(queryByText(/does not match this key/)).toBeNull();
  });

  it('a generate click calls POST /api/ota/keygen with the current name and refreshes status', async () => {
    h.backendFetch
      .mockImplementationOnce(async () => jsonResponse({ ok: true, exists: false, publicKey: null }))
      .mockImplementationOnce(async () => jsonResponse({ ota: {} }))
      .mockImplementationOnce(async () => jsonResponse({ ok: true, exists: true, publicKey: 'pk-fresh' }))
      .mockImplementationOnce(async () => jsonResponse({ ota: {} }));
    h.backendPostJson.mockResolvedValue(jsonResponse({ ok: true, publicKey: 'pk-fresh' }));
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText('Generate'));
    fireEvent.click(getByText('Generate'));

    await waitFor(() => expect(h.backendPostJson).toHaveBeenCalledWith('/api/ota/keygen?name=default', undefined));
    await waitFor(() => getByText(/Generated\. Public key/));
  });

  it('surfaces a keygen failure (e.g. server-side "already exists" refusal) as an error, not a crash', async () => {
    h.backendFetch.mockImplementation(async (path: string) =>
      path.startsWith('/api/ota/keys') ? jsonResponse({ ok: true, exists: false, publicKey: null }) : jsonResponse({ ota: {} }));
    h.backendPostJson.mockResolvedValue(jsonResponse({ ok: false, error: 'already exists — refusing to overwrite' }, false));
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText('Generate'));
    fireEvent.click(getByText('Generate'));

    await waitFor(() => getByText(/refusing to overwrite/));
  });
});
