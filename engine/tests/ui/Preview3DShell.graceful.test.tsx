/** Preview3DShell graceful WebGL-unavailable path (Phase 2). Isolated in its own
 *  file: a createPreviewScene mock that THROWS, shared with other tests in one file,
 *  trips a vitest cross-test async-error-attribution quirk (the throw surfaces as an
 *  unhandled error against a sibling test). Alone it's clean. */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../packages/modoki/src/editor/panels/previewScene', () => ({
  createPreviewScene: vi.fn(() => { throw new Error('no WebGL context'); }),
}));

import { createPreviewScene } from '../../packages/modoki/src/editor/panels/previewScene';
import { Preview3DShell } from '../../packages/modoki/src/editor/panels/Preview3DShell';

describe('Preview3DShell — WebGL unavailable', () => {
  it('shows a graceful message instead of crashing', async () => {
    expect((createPreviewScene as Mock).getMockImplementation()).toBeTypeOf('function');
    const { findByText } = render(<Preview3DShell populate={vi.fn()} resetKey="a" />);
    expect(await findByText(/3D preview unavailable/)).not.toBeNull();
  });
});
