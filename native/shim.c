/*
 * The module's exports: ML-DSA-87 over buffers in linear memory. The caller
 * owns every buffer and passes pointers. Each export returns upstream's
 * result, where 0 means success. mldsa87_sign can also return upstream's
 * MLD_ERR_INVALID_ARG itself.
 */
#include <stddef.h>
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

/*
 * Pure ML-DSA.Sign with the Signing randomness as an argument: Sign_internal
 * over M' = 0x00 || len(ctx) || ctx || message. The signature is always
 * MLDSA87_BYTES long, so there is no length out-parameter. A Context over
 * 255 bytes returns MLD_ERR_INVALID_ARG.
 */
EXPORT("mldsa87_sign")
int mldsa87_sign(uint8_t *signature, const uint8_t *message,
                 size_t message_length, const uint8_t *context,
                 size_t context_length, const uint8_t *rnd,
                 const uint8_t *secret_key)
{
  uint8_t prefix[MLD_DOMAIN_SEPARATION_MAX_BYTES];
  size_t prefix_length =
      PQCP_MLDSA_NATIVE_MLDSA87_prepare_domain_separation_prefix(
          prefix, NULL, 0, context, context_length, MLD_PREHASH_NONE);
  if (prefix_length == 0)
  {
    return MLD_ERR_INVALID_ARG;
  }
  return PQCP_MLDSA_NATIVE_MLDSA87_signature_internal(
      signature, message, message_length, prefix, prefix_length, rnd,
      secret_key, 0 /* externalmu */);
}

EXPORT("mldsa87_verify")
int mldsa87_verify(const uint8_t *signature, const uint8_t *message,
                   size_t message_length, const uint8_t *context,
                   size_t context_length, const uint8_t *public_key)
{
  return PQCP_MLDSA_NATIVE_MLDSA87_verify(signature, message, message_length,
                                          context, context_length, public_key);
}
