// Every implementation gets the same random inputs, and each result is the mean over ITERATIONS calls after
// WARM_UP calls.
export const ITERATIONS = 300;
export const WARM_UP = 50;
export const MESSAGE_BYTES = 1024;
export const CONTEXT_BYTES = 32;

export type Operation = "keygen" | "sign" | "verify";
/** The operations the package must run no slower than the Oracle. keygen is measured but not gated. */
export const GATED = new Set<Operation>(["sign", "verify"]);

/** Mean milliseconds per call of each operation. */
export type Means = Record<Operation, number>;

export interface OracleComparison {
  /** The Node version, or the browser's user agent. */
  runtime: string;
  package: Means;
  oracle: Means;
}

declare module "vitest" {
  export interface TaskMeta {
    oracleComparison?: OracleComparison;
  }
}
