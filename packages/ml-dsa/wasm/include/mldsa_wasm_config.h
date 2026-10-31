/*
 * mldsa-native config for the wasm32 module, passed to the compiler as
 * MLD_CONFIG_FILE. The module is upstream's portable C variant. This file sets
 * only the options below and then includes upstream's default config, so every
 * other option keeps upstream's default at the pin.
 *
 * The module has seven config differences from upstream's CT runs. Record
 * 0002 in docs/adr/ holds the reasons.
 *
 * 1. MLD_CONFIG_MULTILEVEL_BUILD puts ML-DSA-44, ML-DSA-65, and ML-DSA-87 in
 *    one module, with their shared code once. The build script passes
 *    MLD_CONFIG_MULTILEVEL_WITH_SHARED for ML-DSA-44 and
 *    MLD_CONFIG_MULTILEVEL_NO_SHARED for the other two.
 * 2. MLD_CONFIG_NO_RANDOMIZED_API removes the functions that draw randomness.
 *    The module imports nothing, and the caller supplies the seed and the
 *    signing randomness.
 * 3. MLD_CONFIG_CUSTOM_MEMCPY and MLD_CONFIG_CUSTOM_MEMSET map to the
 *    compiler's builtins, because the build links no libc. With
 *    bulk-memory-opt, clang lowers them to memory.copy and memory.fill.
 * 4. MLD_CONFIG_NO_ASM_VALUE_BARRIER selects upstream's volatile value
 *    barrier. The default inline-assembly barrier leaves no instruction in a
 *    wasm module, so an engine's optimizing compiler could see through it.
 * 5. MLD_CONFIG_KEYGEN_PCT stays unset, because upstream's pairwise
 *    consistency test calls signature(), one of the functions that item 2
 *    removes.
 * 6. MLD_CONFIG_CT_TESTING_ENABLED stays unset. It adds valgrind annotations
 *    for testing only.
 * 7. The namespace prefix is mldsa, which the build script passes as
 *    MLD_CONFIG_NAMESPACE_PREFIX. It changes only symbol names.
 */
#ifndef MLDSA_WASM_CONFIG_H
#define MLDSA_WASM_CONFIG_H

#define MLD_CONFIG_MULTILEVEL_BUILD
#define MLD_CONFIG_NO_RANDOMIZED_API
#define MLD_CONFIG_NO_ASM_VALUE_BARRIER

#define MLD_CONFIG_CUSTOM_MEMCPY
#define MLD_CONFIG_CUSTOM_MEMSET
#if !defined(__ASSEMBLER__)
#include <stddef.h>
static inline void *mld_memcpy(void *dest, const void *src, size_t n)
{
  return __builtin_memcpy(dest, src, n);
}
static inline void *mld_memset(void *s, int c, size_t n)
{
  return __builtin_memset(s, c, n);
}
#endif /* !__ASSEMBLER__ */

#include "mldsa_native_config.h"

#endif /* !MLDSA_WASM_CONFIG_H */
