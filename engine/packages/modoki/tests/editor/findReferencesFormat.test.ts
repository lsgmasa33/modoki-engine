/** Unit tests for the Find References dialog's pure chain-formatting helpers
 *  (#284) — the panel itself is not mounted (CLAUDE.md: editor `.tsx` isn't
 *  expected to carry unit tests). */

import { describe, it, expect } from 'vitest';
import {
  originBadge, stepNodeLabel, formatChainStep, formatChain,
  type RefChainStepLike, type RefHitLike, type RefNodeLike,
} from '../../src/editor/panels/findReferencesFormat';

const node = (over: Partial<RefNodeLike> = {}): RefNodeLike => ({
  kind: 'asset', id: 'asset:/x.mat.json', path: '/x.mat.json', name: 'x.mat.json', ...over,
});

describe('originBadge', () => {
  it('returns empty for an ordinary authored ref', () => {
    expect(originBadge('own')).toBe('');
  });
  it('labels every implicit-edge origin', () => {
    expect(originBadge('derived-sprite')).toBe('derived sprite');
    expect(originBadge('slice')).toBe('slice');
    expect(originBadge('atlas-member')).toBe('atlas member');
    expect(originBadge('entity-ref')).toBe('entity ref');
  });
  it('falls back to the raw string for an unknown origin', () => {
    expect(originBadge('mystery')).toBe('mystery');
  });
});

describe('stepNodeLabel', () => {
  it('uses the node name when the referrer has its own guid', () => {
    const step: RefChainStepLike = { node: node({ name: 'Player' }), via: 'material', origin: 'own' };
    expect(stepNodeLabel(step)).toBe('Player');
  });
  it('renders Entity@file.json when the referrer has no guid of its own', () => {
    const step: RefChainStepLike = {
      node: node({ kind: 'asset', name: 'tray-badge.prefab.json' }),
      fromEntity: 'Coin', via: 'Renderable2D.sprite', origin: 'own',
    };
    expect(stepNodeLabel(step)).toBe('Coin@tray-badge.prefab.json');
  });
});

describe('formatChainStep', () => {
  it('renders a plain ordinary ref with no badge', () => {
    const step: RefChainStepLike = { node: node({ name: 'Player' }), via: 'material.map', origin: 'own' };
    expect(formatChainStep(step)).toBe('Player [via material.map]');
  });
  it('appends the origin badge for an implicit edge', () => {
    const step: RefChainStepLike = { node: node({ name: 'Icon' }), via: 'imageSrc', origin: 'derived-sprite' };
    expect(formatChainStep(step)).toBe('Icon [via imageSrc, derived sprite]');
  });
});

describe('formatChain', () => {
  it('joins a direct hit (one step) into "A [via] -> target"', () => {
    const hit: RefHitLike = {
      from: node({ name: 'Player' }), hops: 1, reachable: true,
      chain: [{ node: node({ name: 'Player' }), via: 'material.map', origin: 'own' }],
    };
    expect(formatChain(hit, 'brick.png')).toBe('Player [via material.map] → brick.png');
  });

  it('joins a multi-hop indirect chain in order, outermost referrer first', () => {
    const hit: RefHitLike = {
      from: node({ kind: 'entity', name: 'Player' }), hops: 2, reachable: true,
      chain: [
        { node: node({ kind: 'entity', name: 'Player' }), via: 'Renderable3D.mesh', origin: 'own' },
        { node: node({ name: 'PlayerMat.mat.json' }), via: 'material.map', origin: 'own' },
      ],
    };
    expect(formatChain(hit, 'brick.png')).toBe(
      'Player [via Renderable3D.mesh] → PlayerMat.mat.json [via material.map] → brick.png',
    );
  });
});
