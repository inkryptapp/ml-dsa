import { parentPort, workerData } from "node:worker_threads";
import { runKnownVector } from "./known-vector.mjs";

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort takes no target origin
parentPort.postMessage(await runKnownVector(workerData));
