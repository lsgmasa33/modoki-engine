/** Build-plugin re-export of the shared asset-type classifier. The canonical
 *  source lives in the modoki package (runtime/loaders/assetTypeClassifier) so the
 *  editor/runtime can share it without a package → plugins back-edge; the build
 *  plugins import it from here to keep their import paths local. */
export {
  JSON_ASSET_SUFFIX_TYPE,
  classifyJsonAssetSuffix,
  BINARY_EXT_TYPE,
  ID_BEARING_TYPES,
} from '../packages/modoki/src/runtime/loaders/assetTypeClassifier';
