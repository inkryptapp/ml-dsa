// Values from upstream's C headers at the pin that size the package's regions
// or that the package passes to upstream's functions. Each comment names the
// C macro or expression that the value equals in a wasm32 build.

/** `MLDSA_TRBYTES`, the length of the public-key hash. */
export const publicKeyHashBytes = 64;

/**
 * `MLDSA_SK_TR_OFFSET`, where the public-key hash starts in an encoded secret
 * key. The 32-byte rho and the 32-byte K come before it.
 */
export const publicKeyHashOffset = 64;

/** `MLDSA_CRHBYTES`, the length of a message representative. */
export const messageRepresentativeBytes = 64;

/** `MLD_DOMAIN_SEPARATION_MAX_BYTES`, the space that the prefix function may write. */
export const prefixBytes = 332;

/** `sizeof(mld_shake256ctx)`, the size of a SHAKE256 state. */
export const shakeStateBytes = 208;

/** `_Alignof(mld_shake256ctx)`, the alignment of a SHAKE256 state. */
export const shakeStateAlignment = 8;

/** `MLD_PREHASH_NONE`, the hash mode that asks the prefix function for pure ML-DSA. */
export const pureMlDsa = 0;
