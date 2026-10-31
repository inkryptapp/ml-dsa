# Tests for nix/lib.nix. Each bad input must make its function throw, and each
# good input must give the expected value. The check command runs
#
#   scripts/nix eval --json --file nix/tests.nix
#
# and fails unless the printed list of broken cases is empty. builtins.tryEval
# sees only that a function threw, not its message, so the cases use made-up
# input. flake.nix applies the same functions to the real files, and Nix
# prints the message when one of them fails.
let
  lib = import ./lib.nix;

  nixpkgsLocked = {
    type = "github";
    owner = "NixOS";
    repo = "nixpkgs";
    rev = "6b316287bae2ee04c9b93c8c858d930fd07d7338";
    narHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    lastModified = 1780453794;
  };

  # The shape of upstream's flake.lock, with a second nixpkgs node that the
  # root names under another input.
  lock = {
    version = 7;
    root = "root";
    nodes = {
      root.inputs = {
        nixpkgs = "nixpkgs";
        nixpkgs-unstable = "nixpkgs-unstable";
      };
      nixpkgs.locked = nixpkgsLocked;
      nixpkgs-unstable.locked = nixpkgsLocked // {
        rev = "b5aa0fbd538984f6e3d201be0005b4463d8b09f8";
      };
    };
  };

  withNixpkgs =
    node:
    lock
    // {
      nodes = lock.nodes // {
        nixpkgs = node;
      };
    };
  withRootInputs =
    inputs:
    lock
    // {
      nodes = lock.nodes // {
        root.inputs = inputs;
      };
    };

  sizes = {
    chunkBytes = 65536;
    memoryBytes = 327680;
    stackBytes = 196608;
  };

  throws = value: !(builtins.tryEval (builtins.deepSeq value value)).success;
  gives = expected: value: !(throws value) && value == expected;

  cases = {
    # The fetch arguments name the node by its narHash, and leave out the
    # lastModified field, which builtins.fetchTree doesn't need.
    "upstreamNixpkgs reads the node that the root's nixpkgs input names" =
      gives (removeAttrs nixpkgsLocked [ "lastModified" ])
        (lib.upstreamNixpkgs lock);
    "upstreamNixpkgs rejects a lock that isn't an object" = throws (lib.upstreamNixpkgs [ ]);
    "upstreamNixpkgs rejects a lock without its root node" = throws (
      lib.upstreamNixpkgs (lock // { root = "missing"; })
    );
    "upstreamNixpkgs rejects a root without inputs" = throws (
      lib.upstreamNixpkgs (lock // { nodes = lock.nodes // { root = { }; }; })
    );
    "upstreamNixpkgs rejects a root without a nixpkgs input" = throws (
      lib.upstreamNixpkgs (withRootInputs { nixpkgs-unstable = "nixpkgs-unstable"; })
    );
    "upstreamNixpkgs rejects a nixpkgs input that follows another input" = throws (
      lib.upstreamNixpkgs (withRootInputs { nixpkgs = [ "nixpkgs-unstable" ]; })
    );
    "upstreamNixpkgs rejects a nixpkgs input that names a missing node" = throws (
      lib.upstreamNixpkgs (withRootInputs { nixpkgs = "nixpkgs_2"; })
    );
    "upstreamNixpkgs rejects a node without a locked entry" = throws (
      lib.upstreamNixpkgs (withNixpkgs { original = { }; })
    );
    "upstreamNixpkgs rejects a node that isn't on GitHub" = throws (
      lib.upstreamNixpkgs (withNixpkgs {
        locked = nixpkgsLocked // {
          type = "tarball";
          url = "https://example.com/nixpkgs.tar.gz";
        };
      })
    );
    "upstreamNixpkgs rejects a node without a narHash" = throws (
      lib.upstreamNixpkgs (withNixpkgs {
        locked = removeAttrs nixpkgsLocked [ "narHash" ];
      })
    );

    "sizes accepts valid sizes" = gives sizes (lib.sizes sizes);
    "sizes rejects a value that isn't an object" = throws (lib.sizes [ ]);
    "sizes rejects a missing key" = throws (lib.sizes (removeAttrs sizes [ "chunkBytes" ]));
    "sizes rejects an extra key" = throws (lib.sizes (sizes // { heapBytes = 65536; }));
    "sizes rejects a string" = throws (lib.sizes (sizes // { chunkBytes = "65536"; }));
    "sizes rejects a float" = throws (lib.sizes (sizes // { chunkBytes = 65536.0; }));
    "sizes rejects zero" = throws (lib.sizes (sizes // { chunkBytes = 0; }));
    "sizes rejects a negative size" = throws (lib.sizes (sizes // { chunkBytes = -65536; }));
    "sizes rejects a linear memory that isn't whole 64 KiB pages" = throws (
      lib.sizes (sizes // { memoryBytes = 327681; })
    );
    "sizes rejects a wasm stack that isn't a multiple of 16" = throws (
      lib.sizes (sizes // { stackBytes = 196600; })
    );
    "sizes rejects a wasm stack that fills the linear memory" = throws (
      lib.sizes (sizes // { stackBytes = 327680; })
    );
  };
in
builtins.filter (name: !cases.${name}) (builtins.attrNames cases)
