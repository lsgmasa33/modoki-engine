/** Pure color + position math for the particle GradientEditor (extracted for testability). */

import type { RGB } from '@modoki/engine/runtime';

export function rgbToHex(c: RGB): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** Client x → normalized stop position t ∈ [0,1] within a strip's bounding rect. */
export function tAt(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}
