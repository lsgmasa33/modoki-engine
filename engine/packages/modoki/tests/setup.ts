import { afterAll } from 'vitest';
import { installScratchDirCleanup } from './helpers/scratchDir';

// Scratch dirs made with makeScratchDir are removed after each test file (#1117). The engine
// config's engine/tests/setup.ts does the same. Without this, makeScratchDir refuses to create a dir.
installScratchDirCleanup(afterAll);
