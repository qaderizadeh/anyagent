/**
 * Minimal TypeScript declarations for the WebAssembly globals used by the
 * DeepSeek proof-of-work solver.
 *
 * This project targets Node.js 20+ with `lib: ["ES2022"]` and no DOM lib,
 * so the `WebAssembly` global is not typed by default. Only the subset we
 * use is declared here.
 */

declare namespace WebAssembly {
  type BufferSource = ArrayBuffer | ArrayBufferView;

  interface Module {}

  interface Imports {
    [key: string]: Record<string, unknown>;
  }

  interface Instance {
    exports: Record<string, unknown>;
  }

  class Memory {
    constructor(descriptor: { initial: number; maximum?: number });
    readonly buffer: ArrayBuffer;
  }

  function compile(bytes: BufferSource): Promise<Module>;
  function instantiate(module: Module, imports?: Imports): Promise<Instance>;
}