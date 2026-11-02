/* One fp16 SIMD instruction, f16x8.splat, for the check's compiler witness. */
typedef __fp16 f16x8 __attribute__((vector_size(16)));

f16x8 splat(float x) { return __builtin_wasm_splat_f16x8(x); }
