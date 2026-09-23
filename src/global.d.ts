/**
 * Minimal typings for the WebAssembly globals used by the proof-of-work
 * solver. This project targets Node 20+ with `lib: ["ES2022"]` and no DOM
 * lib, so `WebAssembly` is not typed by default.
 *
 * That's why the vendored wasm needs these declarations:
 *   assert sha3_wasm_bg.wasm exports memory, __wbindgen_export_0,
 *   __wbindgen_add_to_stack_pointer and wasm_solve;
 *   assert wasm_solve returns status 0 (no solution) or non-zero (solved),
 *   with the answer written as a float64 at offset 8 of the return area.
 * Reading them here keeps the solver honest and the compiler quiet.
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
  function instantiate(bytes: BufferSource, imports?: Imports): Promise<{ module: Module; instance: Instance }>;
  function instantiate(module: Module, imports?: Imports): Promise<Instance>;
}
