/*
 * mldsa-native configuration for the freestanding wasm32 build, selected with
 * -DMLD_CONFIG_FILE="mldsa87_config.h". It sets only the options below, then
 * includes upstream's mldsa_native_config.h for every other default, so the
 * inline-asm value barrier and zeroisation stay upstream's.
 */
#ifndef MLDSA87_CONFIG_H
#define MLDSA87_CONFIG_H

#define MLD_CONFIG_PARAMETER_SET 87

/* The Seed and Signing randomness are arguments, so the module has no RNG
 * (ADR 0003). This also turns off the keygen pairwise-consistency test. */
#define MLD_CONFIG_NO_RANDOMIZED_API

/* With -mbulk-memory these compile to single memory.copy and memory.fill
 * instructions, so no copy or fill code in the module is ours (ADR 0005).
 * Setting them also drops upstream's <string.h> include, which src/ct.h
 * relies on for size_t, so <stddef.h> supplies it. */
#if !defined(__ASSEMBLER__)
#include <stddef.h>
#endif
#define MLD_CONFIG_CUSTOM_MEMCPY
#define mld_memcpy __builtin_memcpy
#define MLD_CONFIG_CUSTOM_MEMSET
#define mld_memset __builtin_memset

#include "mldsa_native_config.h"

#endif /* !MLDSA87_CONFIG_H */
