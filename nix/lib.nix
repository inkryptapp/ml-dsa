# The rules that flake.nix applies to its two data files, as pure functions so
# that nix/tests.nix can feed them bad input. Each rule fails with throw, which
# builtins.tryEval can catch.
{
  # Returns the builtins.fetchTree arguments of the nixpkgs node that
  # upstream's parsed flake.lock locks for its root's `nixpkgs` input.
  # Upstream's lock also holds `nixpkgs-unstable`, which supplies only cbmc, so
  # the node is found through the root's input by name.
  upstreamNixpkgs =
    lock:
    let
      fail = reason: throw "vendor/mldsa-native/flake.lock: ${reason}";
      nodes = if builtins.isAttrs lock then lock.nodes or { } else fail "the file isn't a JSON object.";
      rootName = lock.root or "root";
      root = nodes.${rootName} or (fail "the file has no node `${toString rootName}`, which it names as its root.");
      name = (root.inputs or { }).nixpkgs or (fail "the root node has no `nixpkgs` input.");
      node =
        if !builtins.isString name then
          fail "the root's `nixpkgs` input follows another input instead of naming a node."
        else
          nodes.${name} or (fail "the root's `nixpkgs` input names the missing node `${name}`.");
      locked = node.locked or (fail "the `${name}` node has no locked entry.");
    in
    if (locked.type or null) != "github" then
      fail "the `${name}` node isn't on GitHub."
    else if !(locked ? narHash) then
      fail "the `${name}` node has no narHash."
    else
      {
        inherit (locked)
          type
          owner
          repo
          rev
          narHash
          ;
      };

  # Returns the parsed sizes JSON when it holds exactly the three sizes, each a
  # positive integer. The linear memory must be whole 64 KiB wasm pages. The
  # wasm stack must be a multiple of 16, as wasm-ld requires, and smaller than
  # the linear memory.
  sizes =
    value:
    let
      keys = [
        "chunkBytes"
        "memoryBytes"
        "stackBytes"
      ];
      fail = reason: throw "packages/ml-dsa/wasm/sizes.json: ${reason}";
      isMultiple = factor: n: n - (n / factor) * factor == 0;
    in
    if !builtins.isAttrs value || builtins.attrNames value != keys then
      fail "the file must hold exactly the keys ${builtins.concatStringsSep ", " keys}."
    else if !builtins.all (key: builtins.isInt value.${key} && value.${key} > 0) keys then
      fail "every size must be a positive integer."
    else if !isMultiple 65536 value.memoryBytes then
      fail "memoryBytes must be a whole number of 64 KiB wasm pages."
    else if !isMultiple 16 value.stackBytes then
      fail "stackBytes must be a multiple of 16, as wasm-ld requires."
    else if value.stackBytes >= value.memoryBytes then
      fail "stackBytes must be smaller than memoryBytes."
    else
      value;
}
