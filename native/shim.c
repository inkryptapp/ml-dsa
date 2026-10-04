/*
 * The module's exports: ML-DSA-87 over buffers in linear memory. The caller
 * owns every buffer and passes pointers. Each export returns upstream's
 * result, where 0 means success.
 */
#include <stdint.h>

#include "mldsa_native.h"

#define EXPORT(name) __attribute__((export_name(name), visibility("default")))

EXPORT("mldsa87_keygen")
int mldsa87_keygen(uint8_t *public_key, uint8_t *secret_key,
                   const uint8_t *seed)
{
  return PQCP_MLDSA_NATIVE_MLDSA87_keypair_internal(public_key, secret_key,
                                                    seed);
}
