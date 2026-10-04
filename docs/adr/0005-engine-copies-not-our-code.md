# Memory copies and fills are the engine's instructions, not our code

The build targets `-mcpu=mvp -mbulk-memory` and defines `mld_memcpy` and `mld_memset` as `__builtin_memcpy` and `__builtin_memset`, so every copy and fill in the module, including those clang generates for struct assignment, becomes a single `memory.copy` or `memory.fill` instruction. In a plain-mvp build, clang lowers five struct copies of secret signing data to calls to `memcpy`, whatever `MLD_CONFIG_CUSTOM_MEMCPY` says, so we would have had to ship a hand-written `memcpy` on the secret path, code that upstream never tested. With bulk-memory, no copy code in the module is ours. The engine's copy and fill take time that depends only on length, which is public. Bulk memory is supported in Chrome 75+, Firefox 79+, Safari 15+ and Node 12.5+, well inside our support floor. Zeroization still goes through upstream's `mld_zeroize`, so the asm memory clobber after the fill is kept.

## Consequences

- The link step allows no undefined symbols (never `--allow-undefined`), so any future call to `memcpy`, `memset` or `memmove` fails the build instead of linking silently.
- The feature check allows `bulk-memory` and `bulk-memory-opt` only. `sign-ext` is not enabled because the build emits no instructions that use it.

## Considered options

- Plain mvp with a byte-loop `memcpy`: rejected because it puts our own code on the secret path.
