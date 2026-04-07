declare module '@dao-xyz/sqlite3-vec/wasm' {
  const sqlite3InitModule: (options?: unknown) => Promise<unknown>;
  export default sqlite3InitModule;
}
