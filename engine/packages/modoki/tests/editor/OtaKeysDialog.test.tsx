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
  confirmInEditor: vi.fn(),
}));

vi.mock('../../src/editor/utils/saveDialog', () => ({ confirmInEditor: h.confirmInEditor }));

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

  it('Sync decides on Project Settings as they are NOW: a key set since the dialog opened is not replaced unasked (#1993 review)', async () => {
    let settingsReads = 0;
    h.backendFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/ota/keys')) return jsonResponse({ ok: true, exists: true, publicKey: 'pk-new' });
      settingsReads++;
      return jsonResponse({ ota: { publicKey: settingsReads === 1 ? '' : 'pk-shipped' } }); // set by an agent meanwhile
    });
    h.confirmInEditor.mockResolvedValue(false);
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText('Sync to Project Settings'));
    fireEvent.click(getByText('Sync to Project Settings'));
    await waitFor(() => expect(h.confirmInEditor).toHaveBeenCalledTimes(1));
    expect(String(h.confirmInEditor.mock.calls[0][1])).toContain('pk-shipped');
    expect(h.backendPostJson).not.toHaveBeenCalled();
  });

  it('Sync into an EMPTY ota.publicKey (first-time setup) asks nothing and saves', async () => {
    h.backendFetch.mockImplementation(async (path: string) =>
      path.startsWith('/api/ota/keys')
        ? jsonResponse({ ok: true, exists: true, publicKey: 'pk-new' })
        : jsonResponse({ ota: { publicKey: '' } }));
    h.backendPostJson.mockResolvedValue(jsonResponse({ ok: true }));
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText('Sync to Project Settings'));
    fireEvent.click(getByText('Sync to Project Settings'));
    await waitFor(() => expect(h.backendPostJson).toHaveBeenCalledWith('/api/project-settings',
      { ota: { publicKey: 'pk-new' }, expected: { ota: { publicKey: '' } } }));
    expect(h.confirmInEditor).not.toHaveBeenCalled();
  });

  // #2049: the confirm can sit open while an agent writes ota.publicKey, so the write is preconditioned on the value the
  // user was asked about, and the route's 409 is shown rather than read as a save. Mutation: post without `expected`
  // (otaKeySyncBody), or drop the 409 branch — the first assertion, or the notice/error pair, goes red.
  it('Sync is preconditioned on the value the user was asked about, and a 409 says nothing was written (#2049)', async () => {
    let settingsReads = 0;
    h.backendFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/ota/keys')) return jsonResponse({ ok: true, exists: true, publicKey: 'pk-new' });
      settingsReads++;
      return jsonResponse({ ota: { publicKey: settingsReads <= 2 ? 'pk-shipped' : 'pk-agent' } }); // the agent wrote last
    });
    h.confirmInEditor.mockResolvedValue(true);
    h.backendPostJson.mockResolvedValue({ ok: false, status: 409, json: async () => ({ conflict: true, changed: ['ota.publicKey'], error: 'changed' }) } as Response);
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText, queryByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText('Sync to Project Settings'));
    fireEvent.click(getByText('Sync to Project Settings'));
    await waitFor(() => expect(h.backendPostJson).toHaveBeenCalledWith('/api/project-settings',
      { ota: { publicKey: 'pk-new' }, expected: { ota: { publicKey: 'pk-shipped' } } }));
    await waitFor(() => getByText(/changed while you were deciding, so nothing was written/));
    expect(queryByText(/Saved to Project Settings/)).toBeNull();
    expect(settingsReads).toBe(3); // re-read after the refusal, so the banner shows the value there now
  });

  // The 409's other outcome: the concurrent writer synced this very key, so the re-read clears the mismatch and the Sync
  // button is gone — "press Sync again" would point at nothing (close-out review). Mutation: always show the conflict.
  it('a 409 whose re-read already holds this key says so, not "press Sync again"', async () => {
    let settingsReads = 0;
    h.backendFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/ota/keys')) return jsonResponse({ ok: true, exists: true, publicKey: 'pk-new' });
      settingsReads++;
      return jsonResponse({ ota: { publicKey: settingsReads <= 2 ? 'pk-shipped' : 'pk-new' } });
    });
    h.confirmInEditor.mockResolvedValue(true);
    h.backendPostJson.mockResolvedValue({ ok: false, status: 409, json: async () => ({ conflict: true, changed: ['ota.publicKey'], error: 'changed' }) } as Response);
    useEditorStore.setState({ otaKeysOpen: true });

    const { getByText, queryByText } = render(<OtaKeysDialog />);
    await waitFor(() => getByText('Sync to Project Settings'));
    fireEvent.click(getByText('Sync to Project Settings'));
    await waitFor(() => getByText(/already holds this key/));
    expect(queryByText(/press Sync again/)).toBeNull();
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
