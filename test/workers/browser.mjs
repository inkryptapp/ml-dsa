import { runKnownVector } from "./known-vector.mjs";

addEventListener("message", async ({ data }) => {
  postMessage(await runKnownVector(data));
});
