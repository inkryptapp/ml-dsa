/**
 * Test-only entry point, absent from the package's exports map: an instance of the same embedded module with its
 * memory exposed, so tests can check what keygen and sign leave behind.
 */
import { type Exports, type MlDsa87, createMlDsa87, instantiateMlDsa87 } from "./mldsa87.js";

export type Operation = "keygen" | "sign" | "verify";

/** Wraps each call into the module. It must call `call`, then return its result or throw as a trap would. */
export type Around = (operation: Operation, call: () => unknown) => unknown;

export interface MlDsa87ForTesting {
  mlDsa: MlDsa87;
  memory: WebAssembly.Memory;
  /** A view of the stack region, from `__stack_low` up to `__stack_high`, over the memory as it is now. */
  stackBytes(): Uint8Array;
}

/** A fresh instance, not the realm's cached one, so each test starts from untouched memory. */
export async function loadMlDsa87ForTesting(around?: Around): Promise<MlDsa87ForTesting> {
  const exports = await instantiateMlDsa87();
  const wrapped: Exports =
    around === undefined
      ? exports
      : {
          ...exports,
          keygen: (...args) => around("keygen", () => exports.keygen(...args)),
          sign: (...args) => around("sign", () => exports.sign(...args)),
          verify: (...args) => around("verify", () => exports.verify(...args)),
        };
  const { memory, stack } = exports;
  return {
    mlDsa: createMlDsa87(wrapped),
    memory,
    stackBytes: () => new Uint8Array(memory.buffer, stack.low, stack.high - stack.low),
  };
}
