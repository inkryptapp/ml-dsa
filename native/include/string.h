/*
 * Empty stand-in for libc's <string.h>. mldsa-native v2.0.0's src/packing.c
 * includes <string.h> unconditionally, even with MLD_CONFIG_CUSTOM_MEMCPY and
 * MLD_CONFIG_CUSTOM_MEMSET set, and clang's freestanding resource headers
 * don't ship one. Host libc headers stay out of the build (-nostdlibinc).
 */
#ifndef MLDSA87_STRING_H
#define MLDSA87_STRING_H
#endif
