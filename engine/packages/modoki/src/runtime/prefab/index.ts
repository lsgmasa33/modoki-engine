// The #2001 instance model (docs/plans/prefab-instance-model.md). Types only until S1-S3 land; nothing
// imports this folder yet. This index exists so the runtime barrel's import-order test has an entry
// point for the folder (tests/runtime/barrelImportOrder.test.ts).
export type * from './instanceRecord';
