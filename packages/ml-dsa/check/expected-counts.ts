/**
 * The committed instruction counts of the unstripped twin, one entry per
 * nonzero count, each with its reason. `instruction-counts.ts` says how the
 * check counts and compares them. A count and its reason change together, so
 * a changed count fails the check until someone rereads the reason and
 * updates both.
 *
 * The entries follow the twin's function order. A `declassified` reason cites
 * each line of the vendored source that passes a declassified value on or
 * branches on it. The cited sites that several entries share are named
 * constants, so a pin bump that moves a line changes one place.
 */
import type { DeclassifiedSite, ExpectedCount } from "./instruction-counts.ts";

/** Key generation and signing declassify `rho` before they expand the matrix from it. */
const matrixExpansion: readonly DeclassifiedSite[] = [
	{ file: "mldsa/src/sign.c", line: 400, value: "rho" },
	{ file: "mldsa/src/sign.c", line: 1000, value: "rho" },
];

/** When `MLDSA_ETA` is 2, the eta sampler declassifies each `t_valid` before it branches on it. */
const etaTwoRejection: readonly DeclassifiedSite[] = [
	{ file: "mldsa/src/poly_kl.c", line: 243, value: "t_valid" },
	{ file: "mldsa/src/poly_kl.c", line: 250, value: "t_valid" },
];

/** When `MLDSA_ETA` is 4, the eta sampler declassifies each `t_valid` before it branches on it. */
const etaFourRejection: readonly DeclassifiedSite[] = [
	{ file: "mldsa/src/poly_kl.c", line: 258, value: "t_valid" },
	{ file: "mldsa/src/poly_kl.c", line: 264, value: "t_valid" },
];

/** Signing declassifies `challenge_bytes` before it samples the challenge from them. */
const challenge: readonly DeclassifiedSite[] = [
	{ file: "mldsa/src/sign.c", line: 786, value: "challenge_bytes" },
];

/** Signing declassifies `w0` and `w1` before it packs the hint from them. */
const hintPacking: readonly DeclassifiedSite[] = [
	{ file: "mldsa/src/sign.c", line: 910, value: "w0" },
	{ file: "mldsa/src/sign.c", line: 910, value: "w1" },
];

/** Verification declassifies `cmp` before it turns it into the return code. */
const verificationResult: readonly DeclassifiedSite[] = [
	{ file: "mldsa/src/sign.c", line: 1309, value: "cmp" },
];

/**
 * Signing declassifies the result of each rejection check before it branches
 * on it, and `w0` and `w1` before it packs the hint.
 */
const signingRejection: readonly DeclassifiedSite[] = [
	{ file: "mldsa/src/sign.c", line: 603, value: "z_invalid" },
	{ file: "mldsa/src/sign.c", line: 859, value: "w0_invalid" },
	{ file: "mldsa/src/sign.c", line: 876, value: "h_invalid" },
	...hintPacking,
];

export const expectedCounts: readonly ExpectedCount[] = [
	{
		function: "mldsa_shake128_absorb",
		class: "br_if",
		count: 3,
		reason: {
			kind: "public",
			why: "The branches come from the `while (inlen >= r - pos)` loop of `keccak_absorb`, with `r` set to `SHAKE128_RATE`. They test only `inlen` and `state->pos`, which depend on input lengths, never on the absorbed bytes.",
		},
	},
	{
		function: "mldsa_shake128_squeeze",
		class: "br_if",
		count: 3,
		reason: {
			kind: "public",
			why: "The branches come from `keccak_squeeze` with `r` set to `SHAKE128_RATE`: the loop test `bytes_to_go > 0` and the block-boundary test `pos == r`. Both depend only on `outlen` and `state->pos`, never on the state bytes.",
		},
	},
	{
		function: "mldsa_shake128_squeeze",
		class: "select",
		count: 1,
		reason: {
			kind: "public",
			why: "The `select` computes the chunk length `i` in `keccak_squeeze` as the smaller of `bytes_to_go` and `r - pos`. Both operands depend only on lengths.",
		},
	},
	{
		function: "mldsa_shake256_absorb",
		class: "br_if",
		count: 3,
		reason: {
			kind: "public",
			why: "The branches come from the `while (inlen >= r - pos)` loop of `keccak_absorb`, with `r` set to `SHAKE256_RATE`. They test only `inlen` and `state->pos`, which depend on input lengths, never on the absorbed bytes.",
		},
	},
	{
		function: "mldsa_shake256_squeeze",
		class: "br_if",
		count: 3,
		reason: {
			kind: "public",
			why: "The branches come from `keccak_squeeze` with `r` set to `SHAKE256_RATE`: the loop test `bytes_to_go > 0` and the block-boundary test `pos == r`. Both depend only on `outlen` and `state->pos`, never on the state bytes.",
		},
	},
	{
		function: "mldsa_shake256_squeeze",
		class: "select",
		count: 1,
		reason: {
			kind: "public",
			why: "The `select` computes the chunk length `i` in `keccak_squeeze` as the smaller of `bytes_to_go` and `r - pos`. Both operands depend only on lengths.",
		},
	},
	{
		function: "mldsa_shake256",
		class: "br_if",
		count: 6,
		reason: {
			kind: "public",
			why: "`mld_shake256` inlines `keccak_absorb` and `keccak_squeeze` with `r` set to `SHAKE256_RATE`. The absorb branches compare `inlen` against the rate, and the squeeze branches test `bytes_to_go > 0` and `pos == r`. All of them depend only on `inlen` and `outlen`, never on the hashed bytes.",
		},
	},
	{
		function: "mldsa_shake256",
		class: "select",
		count: 1,
		reason: {
			kind: "public",
			why: "The `select` computes the chunk length `i` in `keccak_squeeze` as the smaller of `bytes_to_go` and `r - pos`. Both operands depend only on lengths.",
		},
	},
	{
		function: "mld_keccak_absorb_once_x4",
		class: "br_if",
		count: 4,
		reason: {
			kind: "public",
			why: "The branches test `inlen` against the rate `r`: the entry test and back edge of the `while (inlen >= r)` loop, `inlen > 0`, and `inlen == r - 1`. The input length and the rate are public, and no branch reads the absorbed bytes.",
		},
	},
	{
		function: "mldsa_shake128x4_squeezeblocks",
		class: "br_if",
		count: 2,
		reason: {
			kind: "public",
			why: "The branches are the entry test and back edge of the `while (nblocks > 0)` loop in the inlined `mld_keccak_squeezeblocks_x4`. `nblocks` is a public block count from the caller, never a function of the state.",
		},
	},
	{
		function: "mldsa_shake256x4_squeezeblocks",
		class: "br_if",
		count: 2,
		reason: {
			kind: "public",
			why: "The branches are the entry test and back edge of the `while (nblocks > 0)` loop in the inlined `mld_keccak_squeezeblocks_x4`. `nblocks` is a public block count from the caller, never a function of the state.",
		},
	},
	{
		function: "mldsa_keccakf1600_extract_bytes",
		class: "br_if",
		count: 5,
		reason: {
			kind: "public",
			why: "The branches come from the `i < length` byte loop in `mld_keccakf1600_extract_bytes`, which clang unrolls by 4. They are the `length == 0` and `length < 4` tests, the empty-remainder test, and the back edges of the unrolled and remainder loops. All of them depend only on `length`, never on the bytes copied out of the state.",
		},
	},
	{
		function: "mldsa_keccakf1600_xor_bytes",
		class: "br_if",
		count: 5,
		reason: {
			kind: "public",
			why: "The branches come from the `i < length` byte loop in `mld_keccakf1600_xor_bytes`, which clang unrolls by 4. They are the `length == 0` and `length < 4` tests, the empty-remainder test, and the back edges of the unrolled and remainder loops. All of them depend only on `length`, never on the bytes XORed into the state.",
		},
	},
	{
		function: "mldsa_keccakf1600x4_extract_bytes",
		class: "br_if",
		count: 17,
		reason: {
			kind: "public",
			why: "`mld_keccakf1600x4_extract_bytes_c` inlines `mld_keccakf1600_extract_bytes` once per lane, and clang unrolls each byte loop by 4. One shared test skips all 4 lanes when `length` is 0, and each lane adds the `length < 4` test, the empty-remainder test, and the back edges of the unrolled and remainder loops. All of them depend only on `length`, never on the bytes copied out of the state.",
		},
	},
	{
		function: "mldsa_keccakf1600x4_xor_bytes",
		class: "br_if",
		count: 17,
		reason: {
			kind: "public",
			why: "`mld_keccakf1600x4_xor_bytes_c` inlines `mld_keccakf1600_xor_bytes` once per lane, and clang unrolls each byte loop by 4. One shared test skips all 4 lanes when `length` is 0, and each lane adds the `length < 4` test, the empty-remainder test, and the back edges of the unrolled and remainder loops. All of them depend only on `length`, never on the bytes XORed into the state.",
		},
	},
	{
		function: "mldsa_keccakf1600_permute",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the round loop in `mld_keccakf1600_permute_c`, which runs `round` from 0 to `MLD_KECCAK_NROUNDS` in steps of 2. The round count is fixed and never depends on the state.",
		},
	},
	{
		function: "mldsa44_pack_sig_h",
		class: "br_if",
		count: 16,
		reason: {
			kind: "declassified",
			why: "The branches test each hint bit from `mld_make_hint`, the running hint count against `MLDSA_OMEGA`, and the coefficient loop counter against `MLDSA_N`. The hint bits and the count derive from `w0` and `w1`, which upstream declassifies before it calls `mld_pack_sig_h`.",
			sites: hintPacking,
		},
	},
	{
		function: "mldsa44_sig_unpack_hints",
		class: "br_if",
		count: 12,
		reason: {
			kind: "public",
			why: "The branches test the row index `i` against 0 and `MLDSA_K - 1`, the hint counts and hint indices of the signature's hint section against each other and `MLDSA_OMEGA`, the trailing index bytes against 0, and the loop counters. The signature and the row index are public.",
		},
	},
	{
		function: "mldsa_poly_reduce",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_reduce`, which clang unrolls by 2. It tests only the loop counter, and `mld_reduce32` is branch-free.",
		},
	},
	{
		function: "mldsa_poly_caddq",
		class: "opt-blocker load",
		count: 4,
		reason: {
			kind: "public",
			why: "These loads are the value barriers that keep `mld_caddq` branch-free. Each `mld_caddq` reads `mld_ct_opt_blocker_u64` once in `mld_ct_cmask_neg_i32` and once in `mld_ct_sel_int32`, and clang unrolls the loop by 2. The address is a constant and the value is always 0, so the loads don't depend on a coefficient.",
		},
	},
	{
		function: "mldsa_poly_caddq",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_caddq_c`, which clang unrolls by 2. It tests only the loop counter, and `mld_caddq` selects with masks instead of a branch.",
		},
	},
	{
		function: "mldsa_poly_add",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_add`, which clang unrolls by 4. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_poly_sub",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_sub`, which clang unrolls by 4. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_poly_shiftl",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_shiftl`, which clang unrolls by 4. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_poly_ntt",
		class: "br_if",
		count: 12,
		reason: {
			kind: "public",
			why: "clang unrolls the `layer` loop of `mld_poly_ntt_c` into its 8 calls to `mld_ntt_layer`. Layers 1 to 3 keep the `j` loop of `mld_ntt_butterfly_block` in each of their 7 blocks, and layers 4 to 8 keep the `start` loop of `mld_ntt_layer`. Every bound comes from `MLDSA_N` and the layer number, so the branches test only loop counters.",
		},
	},
	{
		function: "mldsa_poly_invntt_tomont",
		class: "br_if",
		count: 13,
		reason: {
			kind: "public",
			why: "clang unrolls the `layer` loop of `mld_poly_invntt_tomont_c` into its 8 calls to `mld_invntt_layer`. Layers 8 to 4 keep the `start` loop, layers 3 to 1 keep the `j` loop in each of their 7 blocks, and one more loop applies `mld_fqscale` to the `MLDSA_N` coefficients. Every bound comes from `MLDSA_N` and the layer number, so the branches test only loop counters.",
		},
	},
	{
		function: "mldsa_poly_pointwise_montgomery",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_pointwise_montgomery_c`, which clang unrolls by 2. It tests only the loop counter, and `mld_montgomery_reduce` is branch-free.",
		},
	},
	{
		function: "mldsa_poly_power2round",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_power2round`, which clang unrolls by 2. It tests only the loop counter, and `mld_power2round` is branch-free.",
		},
	},
	{
		function: "mldsa_poly_uniform",
		class: "br_if",
		count: 8,
		reason: {
			kind: "declassified",
			why: "`mld_poly_uniform` inlines `mld_rej_uniform_c` twice, for the first `MLD_POLY_UNIFORM_NBLOCKS` blocks and for each extra block of the `while (ctr < MLDSA_N)` loop. The `t < MLDSA_Q` tests and the `ctr` tests depend on SHAKE128 output from `rho`, which is public in verification and declassified in key generation and signing. The `pos` tests compare a byte offset against the public `buflen`.",
			sites: matrixExpansion,
		},
	},
	{
		function: "mldsa_poly_uniform_4x",
		class: "br_if",
		count: 36,
		reason: {
			kind: "declassified",
			why: "`mld_poly_uniform_4x` inlines `mld_rej_uniform_c` for each of its 4 lanes, in the initial pass and in the `while` loop, and the loop tests `ctr[0]` to `ctr[3]` against `MLDSA_N`. The `t < MLDSA_Q` tests and the `ctr` tests depend on SHAKE128 output from `rho`, which is public in verification and declassified in key generation and signing. The `pos` tests compare a byte offset against the public `buflen`.",
			sites: matrixExpansion,
		},
	},
	{
		function: "mldsa_polyt1_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N / 4` groups of 4 coefficients in `mld_polyt1_pack`. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_polyt1_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N / 4` groups of 5 bytes in `mld_polyt1_unpack`. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_polyt0_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N / 8` groups of 8 coefficients in `mld_polyt0_pack`. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_polyt0_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N / 8` groups of 13 bytes in `mld_polyt0_unpack`. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_poly_chknorm",
		class: "opt-blocker load",
		count: 3,
		reason: {
			kind: "public",
			why: "These loads are the value barriers that keep `mld_poly_chknorm_c` branch-free. For each coefficient, `mld_ct_abs_i32` reads `mld_ct_opt_blocker_u64` in `mld_ct_cmask_neg_i32` and in `mld_ct_sel_int32`, and the bound test reads it once more in `mld_ct_cmask_neg_i32`. The address is a constant and the value is always 0, so the loads don't depend on a coefficient.",
		},
	},
	{
		function: "mldsa_poly_chknorm",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N` coefficients in `mld_poly_chknorm_c`. The bound test ORs a mask into `t` without a branch, so the branch tests only the loop counter.",
		},
	},
	{
		function: "mldsa_polyw1_pack_88",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N / 4` groups of 4 coefficients in `mld_polyw1_pack_88`. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa_polyw1_pack_32",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch is the back edge of the loop over the `MLDSA_N / 2` pairs of coefficients in `mld_polyw1_pack_32`, which clang unrolls by 2. It tests only the loop counter.",
		},
	},
	{
		function: "mldsa44_poly_decompose",
		class: "opt-blocker load",
		count: 4,
		reason: {
			kind: "public",
			why: "The loads come from the value barriers in the two `mld_ct_cmask_neg_i32` and `mld_ct_sel_int32` pairs of `mld_decompose`, which wrap the high part 44 to 0 and correct the low part. Each load reads `mld_ct_opt_blocker_u64` at a fixed address, so its timing depends on no coefficient.",
		},
	},
	{
		function: "mldsa44_poly_decompose",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_poly_decompose_c` over a counter against `MLDSA_N`. The inlined `mld_decompose` has no branch on the coefficient.",
		},
	},
	{
		function: "mldsa44_poly_use_hint",
		class: "opt-blocker load",
		count: 4,
		reason: {
			kind: "public",
			why: "The loads come from the value barriers of the two `mld_ct_cmask_neg_i32` and `mld_ct_sel_int32` pairs in `mld_decompose`, which `mld_use_hint` inlines. Each load reads `mld_ct_opt_blocker_u64` at a fixed address. Only verification calls `mld_poly_use_hint`, and its inputs come from the public key and the signature.",
		},
	},
	{
		function: "mldsa44_poly_use_hint",
		class: "br_if",
		count: 3,
		reason: {
			kind: "public",
			why: "`mld_use_hint` branches on `hint == 0` and on `a0 > 0`, and `mld_poly_use_hint_c` loops over a counter against `MLDSA_N`. Only verification calls `mld_poly_use_hint`, so the hint and the coefficients come from the public key and the signature.",
		},
	},
	{
		function: "mldsa44_poly_use_hint",
		class: "select",
		count: 2,
		reason: {
			kind: "public",
			why: "`mld_use_hint` wraps the corrected high part with the ternaries `(a1 == 43) ? 0 : a1 + 1` and `(a1 == 0) ? 43 : a1 - 1`. Only verification calls `mld_poly_use_hint`, so `a1` comes from the public key and the signature.",
		},
	},
	{
		function: "mldsa44_poly_uniform_eta_4x",
		class: "br_if",
		count: 52,
		reason: {
			kind: "declassified",
			why: "`mld_rej_eta_c` branches on `t_valid`, which tests whether a nibble is below 15, and upstream declassifies `t_valid` because the sampler may leak which nibbles it rejects. The other branches compare `ctr`, which only accepted nibbles advance, with `MLDSA_N`, and the byte counter `pos` with `buflen`. `mld_poly_uniform_eta_4x` inlines the sampler eight times and repeats while any `ctr` is below `MLDSA_N`.",
			sites: etaTwoRejection,
		},
	},
	{
		function: "mldsa44_polyz_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyz_unpack_c` over a counter against `MLDSA_N / 4`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa44_poly_challenge",
		class: "br_if",
		count: 3,
		reason: {
			kind: "declassified",
			why: "`mld_poly_challenge` loops over `i` up to `MLDSA_N`, squeezes another block when `pos` reaches `SHAKE256_RATE`, and draws bytes `j` until one is at most `i`. In signing, the seed is `challenge_bytes`, which upstream declassifies. In verification, the seed comes from the signature.",
			sites: challenge,
		},
	},
	{
		function: "mldsa44_polyeta_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyeta_pack` over a counter against `MLDSA_N / 8`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa44_polyeta_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyeta_unpack` over a counter against `MLDSA_N / 8`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa44_polyz_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyz_pack` over a counter against `MLDSA_N / 4`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa44_polyvecl_pointwise_acc_montgomery",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyvecl_pointwise_acc_montgomery_c` over a counter against `MLDSA_N`. The inner loop against `MLDSA_L` unrolls fully, and no branch tests a coefficient.",
		},
	},
	{
		function: "mldsa44_signature_internal",
		class: "br_if",
		count: 16,
		reason: {
			kind: "declassified",
			why: "The branches test the public `externalmu` flag, the attempt counter against `MLD_MAX_SIGNING_ATTEMPTS`, and the rejection checks on `z_invalid`, `w0_invalid`, and `h_invalid` from `mld_compute_pack_z` and `mld_attempt_signature_generation`. The rest test each attempt's return code, which follows only from those checks and from the hint count that `mld_pack_sig_h` takes from the declassified `w0` and `w1`.",
			sites: signingRejection,
		},
	},
	{
		function: "mld_H44",
		class: "br_if",
		count: 2,
		reason: {
			kind: "public",
			why: "The two branches of `mld_H` test whether `in2len` and `in3len` are nonzero. Both are lengths, which are public.",
		},
	},
	{
		function: "mldsa44_verify_internal",
		class: "br_if",
		count: 6,
		reason: {
			kind: "public",
			why: "The branches test the public `externalmu` flag, the `mld_polyvecl_chknorm` result for `z` unpacked from the signature, and the `mld_sig_unpack_hints` result for each of the `MLDSA_K` rows. All of them depend only on the signature and the flag.",
		},
	},
	{
		function: "mldsa44_verify_internal",
		class: "opt-blocker load",
		count: 2,
		reason: {
			kind: "public",
			why: "Both loads read the volatile `mld_ct_opt_blocker_u64` for the value barriers in `mld_ct_cmask_nonzero_u32` and `mld_ct_memcmp`, inlined from the challenge comparison. The address is a constant and the value is always zero, so the loads depend on no input.",
		},
	},
	{
		function: "mldsa44_verify_internal",
		class: "select",
		count: 1,
		reason: {
			kind: "declassified",
			why: "The `select` turns `cmp`, the `mld_ct_memcmp` result for the recomputed challenge, into the return code. Upstream declassifies `cmp` as the outcome of verification.",
			sites: verificationResult,
		},
	},
	{
		function: "mldsa44_prepare_domain_separation_prefix",
		class: "br_if",
		count: 19,
		reason: {
			kind: "public",
			why: "The branches test `ctxlen` against 255 and 0, `hashalg` against `MLD_PREHASH_NONE`, `ph` against `NULL`, and `phlen` against 0 and against each digest length in `mld_validate_hash_length`. The lengths, the pointer, and the caller's constant `hashalg` are public, and the context and hash bytes are only copied.",
		},
	},
	{
		function: "mldsa44_prepare_domain_separation_prefix",
		class: "br_table",
		count: 1,
		reason: {
			kind: "public",
			why: "The `br_table` is the `switch` on `hashalg` in the inlined `mld_validate_hash_length`. The caller passes `hashalg` as a public constant.",
		},
	},
	{
		function: "mldsa65_pack_sig_h",
		class: "br_if",
		count: 24,
		reason: {
			kind: "declassified",
			why: "The branches test each hint bit from `mld_make_hint`, the running hint count against `MLDSA_OMEGA`, and the coefficient loop counter against `MLDSA_N`. The hint bits and the count derive from `w0` and `w1`, which upstream declassifies before it calls `mld_pack_sig_h`.",
			sites: hintPacking,
		},
	},
	{
		function: "mldsa65_sig_unpack_hints",
		class: "br_if",
		count: 12,
		reason: {
			kind: "public",
			why: "The branches test the row index `i` against 0 and `MLDSA_K - 1`, the hint counts and hint indices of the signature's hint section against each other and `MLDSA_OMEGA`, the trailing index bytes against 0, and the loop counters. The signature and the row index are public.",
		},
	},
	{
		function: "mldsa65_poly_decompose",
		class: "opt-blocker load",
		count: 2,
		reason: {
			kind: "public",
			why: "The loads come from the value barriers in the `mld_ct_cmask_neg_i32` and `mld_ct_sel_int32` pair of `mld_decompose` that corrects the low part. Each load reads `mld_ct_opt_blocker_u64` at a fixed address, so its timing depends on no coefficient.",
		},
	},
	{
		function: "mldsa65_poly_decompose",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_poly_decompose_c` over a counter against `MLDSA_N`. The inlined `mld_decompose` has no branch on the coefficient.",
		},
	},
	{
		function: "mldsa65_poly_use_hint",
		class: "opt-blocker load",
		count: 2,
		reason: {
			kind: "public",
			why: "The loads come from the value barriers of the `mld_ct_cmask_neg_i32` and `mld_ct_sel_int32` pair in `mld_decompose`, which `mld_use_hint` inlines. Each load reads `mld_ct_opt_blocker_u64` at a fixed address. Only verification calls `mld_poly_use_hint`, and its inputs come from the public key and the signature.",
		},
	},
	{
		function: "mldsa65_poly_use_hint",
		class: "br_if",
		count: 3,
		reason: {
			kind: "public",
			why: "`mld_use_hint` branches on `hint == 0` and on `a0 > 0`, and `mld_poly_use_hint_c` loops over a counter against `MLDSA_N`. Only verification calls `mld_poly_use_hint`, so the hint and the coefficients come from the public key and the signature.",
		},
	},
	{
		function: "mldsa65_poly_uniform_eta_4x",
		class: "br_if",
		count: 52,
		reason: {
			kind: "declassified",
			why: "`mld_rej_eta_c` branches on `t_valid`, which tests whether a nibble is below 9, and upstream declassifies `t_valid` because the sampler may leak which nibbles it rejects. The other branches compare `ctr`, which only accepted nibbles advance, with `MLDSA_N`, and the byte counter `pos` with `buflen`. `mld_poly_uniform_eta_4x` inlines the sampler eight times and repeats while any `ctr` is below `MLDSA_N`.",
			sites: etaFourRejection,
		},
	},
	{
		function: "mldsa65_poly_uniform_gamma1",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "`mld_poly_uniform_gamma1` inlines `mld_polyz_unpack_c`, and the branch closes its loop over a counter against `MLDSA_N / 2`. No branch tests a sampled coefficient.",
		},
	},
	{
		function: "mldsa65_polyz_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyz_unpack_c` over a counter against `MLDSA_N / 2`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa65_poly_uniform_gamma1_4x",
		class: "br_if",
		count: 4,
		reason: {
			kind: "public",
			why: "`mld_poly_uniform_gamma1_4x` inlines `mld_polyz_unpack_c` four times, and each copy closes its loop over a counter against `MLDSA_N / 2`. No branch tests a sampled coefficient.",
		},
	},
	{
		function: "mldsa65_poly_challenge",
		class: "br_if",
		count: 3,
		reason: {
			kind: "declassified",
			why: "`mld_poly_challenge` loops over `i` up to `MLDSA_N`, squeezes another block when `pos` reaches `SHAKE256_RATE`, and draws bytes `j` until one is at most `i`. In signing, the seed is `challenge_bytes`, which upstream declassifies. In verification, the seed comes from the signature.",
			sites: challenge,
		},
	},
	{
		function: "mldsa65_polyeta_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyeta_pack` over a counter against `MLDSA_N / 2`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa65_polyeta_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyeta_unpack` over a counter against `MLDSA_N / 2`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa65_polyz_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyz_pack` over a counter against `MLDSA_N / 2`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa65_polyvecl_pointwise_acc_montgomery",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyvecl_pointwise_acc_montgomery_c` over a counter against `MLDSA_N`. The inner loop against `MLDSA_L` unrolls fully, and no branch tests a coefficient.",
		},
	},
	{
		function: "mldsa65_polyvec_matrix_expand_eager",
		class: "div and rem",
		count: 8,
		reason: {
			kind: "public",
			why: "The divisions compute `(i + j) / MLDSA_L` and `(i + j) % MLDSA_L` for the four entries of each batch in `mld_polyvec_matrix_expand_eager`. `i` and `j` are loop counters and `MLDSA_L` is 5, so every operand is public.",
		},
	},
	{
		function: "mldsa65_polyvec_matrix_expand_eager",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyvec_matrix_expand_eager` that samples four entries per pass, over `i` in steps of 4 up to 28. The two leftover entries become two `mld_poly_uniform` calls with constant indices and add no branch.",
		},
	},
	{
		function: "mldsa65_signature_internal",
		class: "br_if",
		count: 21,
		reason: {
			kind: "declassified",
			why: "The branches test the public `externalmu` flag, the attempt counter against `MLD_MAX_SIGNING_ATTEMPTS`, and the rejection checks on `z_invalid`, `w0_invalid`, and `h_invalid` from `mld_compute_pack_z` and `mld_attempt_signature_generation`. The rest test each attempt's return code, which follows only from those checks and from the hint count that `mld_pack_sig_h` takes from the declassified `w0` and `w1`.",
			sites: signingRejection,
		},
	},
	{
		function: "mld_H65",
		class: "br_if",
		count: 2,
		reason: {
			kind: "public",
			why: "The two branches of `mld_H` test whether `in2len` and `in3len` are nonzero. Both are lengths, which are public.",
		},
	},
	{
		function: "mldsa65_verify_internal",
		class: "br_if",
		count: 9,
		reason: {
			kind: "public",
			why: "The branches test the public `externalmu` flag, the `mld_polyvecl_chknorm` result for `z` unpacked from the signature, the `mld_sig_unpack_hints` result for each of the `MLDSA_K` rows, and the loop counter of `mld_ct_memcmp` against `MLDSA_CTILDEBYTES`. All of them depend only on the signature, the flag, and constants.",
		},
	},
	{
		function: "mldsa65_verify_internal",
		class: "opt-blocker load",
		count: 2,
		reason: {
			kind: "public",
			why: "Both loads read the volatile `mld_ct_opt_blocker_u64` for the value barriers in `mld_ct_cmask_nonzero_u32` and `mld_ct_memcmp`, inlined from the challenge comparison. The address is a constant and the value is always zero, so the loads depend on no input.",
		},
	},
	{
		function: "mldsa65_verify_internal",
		class: "select",
		count: 1,
		reason: {
			kind: "declassified",
			why: "The `select` turns `cmp`, the `mld_ct_memcmp` result for the recomputed challenge, into the return code. Upstream declassifies `cmp` as the outcome of verification.",
			sites: verificationResult,
		},
	},
	{
		function: "mldsa87_pack_sig_h",
		class: "br_if",
		count: 32,
		reason: {
			kind: "declassified",
			why: "The branches test each hint bit from `mld_make_hint`, the running hint count against `MLDSA_OMEGA`, and the coefficient loop counter against `MLDSA_N`. The hint bits and the count derive from `w0` and `w1`, which upstream declassifies before it calls `mld_pack_sig_h`.",
			sites: hintPacking,
		},
	},
	{
		function: "mldsa87_sig_unpack_hints",
		class: "br_if",
		count: 12,
		reason: {
			kind: "public",
			why: "The branches test the row index `i` against 0 and `MLDSA_K - 1`, the hint counts and hint indices of the signature's hint section against each other and `MLDSA_OMEGA`, the trailing index bytes against 0, and the loop counters. The signature and the row index are public.",
		},
	},
	{
		function: "mldsa87_poly_decompose",
		class: "opt-blocker load",
		count: 2,
		reason: {
			kind: "public",
			why: "The loads come from the value barriers in the `mld_ct_cmask_neg_i32` and `mld_ct_sel_int32` pair of `mld_decompose` that corrects the low part. Each load reads `mld_ct_opt_blocker_u64` at a fixed address, so its timing depends on no coefficient.",
		},
	},
	{
		function: "mldsa87_poly_decompose",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_poly_decompose_c` over a counter against `MLDSA_N`. The inlined `mld_decompose` has no branch on the coefficient.",
		},
	},
	{
		function: "mldsa87_poly_use_hint",
		class: "opt-blocker load",
		count: 2,
		reason: {
			kind: "public",
			why: "The loads come from the value barriers of the `mld_ct_cmask_neg_i32` and `mld_ct_sel_int32` pair in `mld_decompose`, which `mld_use_hint` inlines. Each load reads `mld_ct_opt_blocker_u64` at a fixed address. Only verification calls `mld_poly_use_hint`, and its inputs come from the public key and the signature.",
		},
	},
	{
		function: "mldsa87_poly_use_hint",
		class: "br_if",
		count: 3,
		reason: {
			kind: "public",
			why: "`mld_use_hint` branches on `hint == 0` and on `a0 > 0`, and `mld_poly_use_hint_c` loops over a counter against `MLDSA_N`. Only verification calls `mld_poly_use_hint`, so the hint and the coefficients come from the public key and the signature.",
		},
	},
	{
		function: "mldsa87_poly_uniform_eta_4x",
		class: "br_if",
		count: 52,
		reason: {
			kind: "declassified",
			why: "`mld_rej_eta_c` branches on `t_valid`, which tests whether a nibble is below 15, and upstream declassifies `t_valid` because the sampler may leak which nibbles it rejects. The other branches compare `ctr`, which only accepted nibbles advance, with `MLDSA_N`, and the byte counter `pos` with `buflen`. `mld_poly_uniform_eta_4x` inlines the sampler eight times and repeats while any `ctr` is below `MLDSA_N`.",
			sites: etaTwoRejection,
		},
	},
	{
		function: "mldsa87_poly_uniform_gamma1_4x",
		class: "br_if",
		count: 4,
		reason: {
			kind: "public",
			why: "`mld_poly_uniform_gamma1_4x` inlines `mld_polyz_unpack_c` four times, and each copy closes its loop over a counter against `MLDSA_N / 2`. No branch tests a sampled coefficient.",
		},
	},
	{
		function: "mldsa87_polyz_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyz_unpack_c` over a counter against `MLDSA_N / 2`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa87_poly_challenge",
		class: "br_if",
		count: 3,
		reason: {
			kind: "declassified",
			why: "`mld_poly_challenge` loops over `i` up to `MLDSA_N`, squeezes another block when `pos` reaches `SHAKE256_RATE`, and draws bytes `j` until one is at most `i`. In signing, the seed is `challenge_bytes`, which upstream declassifies. In verification, the seed comes from the signature.",
			sites: challenge,
		},
	},
	{
		function: "mldsa87_polyeta_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyeta_pack` over a counter against `MLDSA_N / 8`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa87_polyeta_unpack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyeta_unpack` over a counter against `MLDSA_N / 8`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa87_polyz_pack",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyz_pack` over a counter against `MLDSA_N / 2`. No branch tests a coefficient.",
		},
	},
	{
		function: "mldsa87_polyvecl_pointwise_acc_montgomery",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyvecl_pointwise_acc_montgomery_c` over a counter against `MLDSA_N`. The inner loop against `MLDSA_L` unrolls fully, and no branch tests a coefficient.",
		},
	},
	{
		function: "mldsa87_polyvec_matrix_expand_eager",
		class: "div and rem",
		count: 8,
		reason: {
			kind: "public",
			why: "The divisions compute `(i + j) / MLDSA_L` and `(i + j) % MLDSA_L` for the four entries of each batch in `mld_polyvec_matrix_expand_eager`. `i` and `j` are loop counters and `MLDSA_L` is 7, so every operand is public.",
		},
	},
	{
		function: "mldsa87_polyvec_matrix_expand_eager",
		class: "br_if",
		count: 1,
		reason: {
			kind: "public",
			why: "The branch closes the loop of `mld_polyvec_matrix_expand_eager` that samples four entries per pass, over `i` in steps of 4 up to 56. `MLDSA_K` times `MLDSA_L` is 56, so no entry is left for the second loop.",
		},
	},
	{
		function: "mldsa87_signature_internal",
		class: "br_if",
		count: 14,
		reason: {
			kind: "declassified",
			why: "The branches test the public `externalmu` flag, the attempt counter against `MLD_MAX_SIGNING_ATTEMPTS`, the row counter against `MLDSA_K`, and the rejection checks on `z_invalid`, `w0_invalid`, and `h_invalid` from `mld_compute_pack_z` and `mld_attempt_signature_generation`. The rest test each attempt's return code, which follows only from those checks and from the hint count that `mld_pack_sig_h` takes from the declassified `w0` and `w1`.",
			sites: signingRejection,
		},
	},
	{
		function: "mld_H87",
		class: "br_if",
		count: 2,
		reason: {
			kind: "public",
			why: "The two branches of `mld_H` test whether `in2len` and `in3len` are nonzero. Both are lengths, which are public.",
		},
	},
	{
		function: "mldsa87_verify_internal",
		class: "br_if",
		count: 5,
		reason: {
			kind: "public",
			why: "The branches test the public `externalmu` flag, the `mld_polyvecl_chknorm` result for `z` unpacked from the signature, the `mld_sig_unpack_hints` result per row, and the loop counters over the `MLDSA_K` rows and over the `MLDSA_CTILDEBYTES` bytes of `mld_ct_memcmp`. All of them depend only on the signature, the flag, and constants.",
		},
	},
	{
		function: "mldsa87_verify_internal",
		class: "opt-blocker load",
		count: 2,
		reason: {
			kind: "public",
			why: "Both loads read the volatile `mld_ct_opt_blocker_u64` for the value barriers in `mld_ct_cmask_nonzero_u32` and `mld_ct_memcmp`, inlined from the challenge comparison. The address is a constant and the value is always zero, so the loads depend on no input.",
		},
	},
	{
		function: "mldsa87_verify_internal",
		class: "select",
		count: 1,
		reason: {
			kind: "declassified",
			why: "The `select` turns `cmp`, the `mld_ct_memcmp` result for the recomputed challenge, into the return code. Upstream declassifies `cmp` as the outcome of verification.",
			sites: verificationResult,
		},
	},
];
