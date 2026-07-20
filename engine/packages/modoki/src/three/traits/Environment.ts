import { trait } from 'koota';

/** Environment trait — HDR environment map for reflections and indirect lighting. */
export const Environment = trait({
  hdrPath: '' as string,
  intensity: 1 as number,
  showAsBackground: false,
  backgroundIntensity: 1 as number,
  backgroundBlurriness: 0 as number,
});
