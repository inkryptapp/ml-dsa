# At the engine's stack limit, let verify throw, and let keygen and sign throw the engine's own error

Like any JavaScript function, `keygen`, `sign`, and `verify` can hit the engine's stack-overflow error when the caller has used up the stack. The engine throws it before a function's first statement runs, so no code in the package can catch an overflow at its own entry. Where the overflow lands decides the result. Before the core takes the instance, which covers the call's entry, the read step, the input checks, and the zero checks, the engine's error reaches the caller unchanged, nothing was written, and the instance stays. Inside the core, the call poisons, wipes, and drops the instance, then throws the package `Error` with the engine error as `cause`. An overflow while the core creates an instance also becomes that `cause`, and the slot stays empty for the next call. The core builds that `Error` only after its cleanup, so memory is wiped by then. If building it throws, the package rethrows the stored engine error with a plain `throw`, which makes no call. `verify` is one `try` whose `catch` only returns `false`, so it promises only what it controls. It returns a boolean for every input, and it throws only when too little stack is left to start it.

This record revises four sentences of record 0005. Its opening paragraph says "so `verify` never throws and never rejects a valid signature because of its length", which now holds except at the stack limit. Its **Errors** consequence says "`verify` returns `false` instead of throwing", and its considered option **A fixed message cap in a fixed memory** says "`verify` must answer `false` instead of throwing for any input". Both now hold for every failure that starts inside `verify`. The **Errors** consequence also says "Every other failure is a plain `Error` with the original in `cause`", which gains one exception: a stored engine error that the package can't wrap reaches the caller unchanged.

## Consequences

- `keygen` and `sign` throw only these: a `TypeError` or a `RangeError` with a package message from the read step and the checks, an exception from the caller's own getter or proxy trap (only `sign` runs caller code), the engine's stack-overflow error unchanged, and otherwise the package `Error`.
- A `RangeError` alone doesn't prove a bad input. V8 and JavaScriptCore throw the stack-overflow error as a `RangeError`, and Firefox throws an `InternalError`. The docs of `keygen` and `sign` say so.
- No `catch` before the core turns an engine overflow into a package error.
- A call that ended with a failing return value from mldsa-native stores no exception. If building its package `Error` throws, the error from that attempt reaches the caller, and memory is wiped by then.
- `false` from `verify` means that the signature wasn't shown to be valid. A failed instance creation or an engine failure also returns `false`, and the caller can't tell these cases apart.
- The core's `catch` blocks only assign, and its cleanup makes only four calls, so the wipe still runs when too little stack is left to start a function. A structural check parses the source and enforces both rules.
- In Node, a depth sweep runs `keygen`, `sign`, and `verify` at the JavaScript depths around the stack limit, a wrong-type input included. It widens its window until it has seen at least 5 overflows whose innermost frame is a wasm frame for each operation, and it checks the results above and the wipe after every call. A row of the exit matrix makes `new Error` throw, which pins the plain rethrow.

## Considered options

- **A `verify` that never throws.** No function can promise that, because the engine throws before the function's first statement runs.
- **An async `verify`, or a wrapper function that catches.** Both still throw at the stack limit. The wrapper can't start either, and the engine throws before an async function's body runs too.
- **Wrap an overflow that lands before the core in the package `Error`.** The call wrote nothing and the instance stays, so the engine's own error already says what happened. Building the package `Error` there can fail in the same way.
