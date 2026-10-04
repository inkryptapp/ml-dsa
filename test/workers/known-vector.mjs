/**
 * Imports the package with `fetch` disabled, then runs keygen, sign and verify on the request's inputs. The browser
 * and Node workers share it and differ only in how messages travel. A Worker has no `window` or DOM, so passing
 * here also shows the package needs neither.
 *
 * @param {import("../known-vector.js").KnownVectorRequest} request
 * @returns {Promise<import("../known-vector.js").KnownVectorReply>}
 */
export async function runKnownVector({ packageUrl, seed, sign, verify }) {
  globalThis.fetch = () => {
    throw new Error("the package made a network fetch");
  };
  try {
    const { loadMlDsa87 } = await import(/* @vite-ignore */ packageUrl);
    const mlDsa = await loadMlDsa87();
    const { publicKey, secretKey } = mlDsa.keygen(seed);
    return { publicKey, secretKey, signature: mlDsa.sign(sign), verified: mlDsa.verify(verify) };
  } catch (error) {
    return { error: String(error) };
  }
}
