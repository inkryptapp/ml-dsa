// Each export breaks exactly one type-aware rule. The lint test expects
// these three errors and no others.

const view: Uint8Array = new Uint8Array(4);
const plainObject: object = {};

export const inTemplate: string = `bytes: ${view}`;
export const inSum: string = "bytes: " + view;
export const inString: string = String(plainObject);
