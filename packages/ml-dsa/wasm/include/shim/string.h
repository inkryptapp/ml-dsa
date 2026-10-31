/*
 * An empty <string.h> for the wasm32 build. At mldsa-native v2.0.0,
 * mldsa/src/packing.c includes <string.h> unconditionally, and the build has
 * no libc whose headers could supply it. Clang's own headers hold no string.h.
 *
 * The file declares nothing, so a direct call to memcpy or any other libc
 * function fails to compile. Each pin bump checks whether upstream made the
 * include in packing.c conditional, and deletes this file if it did.
 */
