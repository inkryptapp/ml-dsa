/**
 * Decodes standard, padded base64. Hand-written because `Uint8Array.fromBase64` is newer than the runtime floor.
 * It only ever decodes the committed artifact module, which is public data.
 */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const unpadded = text.replace(/=+$/, "");
  const output = new Uint8Array(Math.floor((unpadded.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let position = 0; position < unpadded.length; position++) {
    buffer = (buffer << 6) | sextet(unpadded.charCodeAt(position));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[index++] = (buffer >> bits) & 0xff;
    }
  }
  return output;
}

function sextet(code: number): number {
  // A-Z
  if (code >= 0x41 && code <= 0x5a) {
    return code - 0x41;
  }
  // a-z
  if (code >= 0x61 && code <= 0x7a) {
    return code - 0x61 + 26;
  }
  // 0-9
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30 + 52;
  }
  // +
  if (code === 0x2b) {
    return 62;
  }
  // /
  if (code === 0x2f) {
    return 63;
  }
  throw new Error(`invalid base64 character code ${code}`);
}
