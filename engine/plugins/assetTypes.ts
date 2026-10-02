/** Build-plugin re-export of the shared asset-type classifier. The canonical
 *  source lives in the modoki package (runtime/loaders/assetTypeClassifier) so the
 *  editor/runtime can share it without a package → plugins back-edge; the build
 *  plugins import it from here to keep their import paths local. */
export {
  JSON_ASSET_SUFFIX_TYPE,
  classifyJsonAssetSuffix,
  classifyJsonAssetPath,
  BINARY_EXT_TYPE,
  classifyBinaryExt,
  ID_BEARING_TYPES,
} from '../packages/modoki/src/runtime/loaders/assetTypeClassifier';

/** URL prefix of the engine's built-in asset root. **Read-only through every project write route** (#1959): its files
 *  ship inside the packaged editor's bundle and are shared by every project, as Unity's registry packages are. Defined
 *  here rather than in the scanner because the backend router may not import the scanner (it is host-agnostic). */
export const ENGINE_ASSETS_URL_PREFIX = '/modoki/assets';
