import { trait } from 'koota';

/** ModelSource — marks the root entity of an imported model.
 *  Tracks the source GLB path and which postprocessor was used to process it. */
export const ModelSource = trait({
  glbPath: '' as string,
  postprocessor: 'none' as string,
  prefix: '' as string,
});
