// The engine can use BLAKE3 for hashing but falls back to a built-in hash when
// this import fails. The published blake3-wasm browser entry cannot be bundled,
// so the build points the import here, as the engine's documentation suggests.
throw new Error('BLAKE3 acceleration is disabled in this build');
export function hash(): never {
  throw new Error('BLAKE3 acceleration is disabled in this build');
}
