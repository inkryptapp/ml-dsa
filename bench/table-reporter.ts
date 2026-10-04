import type { Reporter, TestCase } from "vitest/node";
import {
  CONTEXT_BYTES,
  GATED,
  ITERATIONS,
  MESSAGE_BYTES,
  type Operation,
  type OracleComparison,
  WARM_UP,
} from "./method.js";

const OPERATIONS: Operation[] = ["keygen", "sign", "verify"];

/** Prints every runtime's means as one table once the run ends. */
export class OracleComparisonTable implements Reporter {
  #rows: { project: string; comparison: OracleComparison }[] = [];

  onTestCaseResult(testCase: TestCase): void {
    const { oracleComparison } = testCase.meta();
    if (oracleComparison !== undefined) {
      this.#rows.push({ project: testCase.project.name, comparison: oracleComparison });
    }
  }

  onTestRunEnd(): void {
    if (this.#rows.length === 0) {
      return;
    }
    const lines = [
      `ML-DSA-87 mean ms per call over ${ITERATIONS} calls after ${WARM_UP} warm-up calls, ` +
        `message ${MESSAGE_BYTES} B, Context ${CONTEXT_BYTES} B, hedged sign`,
      "",
      row("operation", "package", "Oracle", "Oracle/package"),
    ];
    for (const { project, comparison } of this.#rows) {
      lines.push(`${project}: ${comparison.runtime}`);
      for (const operation of OPERATIONS) {
        const ours = comparison.package[operation];
        const theirs = comparison.oracle[operation];
        const slower = GATED.has(operation) && ours > theirs ? "  SLOWER THAN THE ORACLE" : "";
        lines.push(
          row(operation, ours.toFixed(3), theirs.toFixed(3), `${(theirs / ours).toFixed(1)}×${slower}`),
        );
      }
    }
    console.log(`\n${lines.join("\n")}\n`);
  }
}

function row(operation: string, ours: string, theirs: string, verdict: string): string {
  return `  ${operation.padEnd(10)}${ours.padStart(10)}${theirs.padStart(10)}  ${verdict}`;
}
