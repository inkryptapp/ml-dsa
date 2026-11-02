# Builds the wasm module from the mldsa-native submodule with the newest clang
# in upstream's CT matrix. The submodule's commit is the only pin. Upstream's
# own flake.lock at that commit names the nixpkgs revision that supplies clang
# and lld, so moving the gitlink moves the source and the compiler together.
# Record 0001 in docs/adr/ holds the reasons.
#
# Run Nix through scripts/nix, and refer to this flake as `.`, never as
# `path:.`, which copies the whole working tree into the store.
{
  description = "ml-dsa: mldsa-native compiled to one wasm32 module";

  # Inside a git repo, Nix leaves a submodule's files out of the flake's source
  # unless the flake asks for them.
  inputs.self.submodules = true;

  outputs =
    { self }:
    let
      lib = import ./nix/lib.nix;

      upstreamLock =
        let
          file = ./vendor/mldsa-native/flake.lock;
        in
        if builtins.pathExists file then
          builtins.fromJSON (builtins.readFile file)
        else
          throw "vendor/mldsa-native has no files in the flake's source. Run `git submodule update --init`, and run Nix 2.27 or later, which reads inputs.self.submodules.";

      nixpkgs = builtins.fetchTree (lib.upstreamNixpkgs upstreamLock);
      sizes = lib.sizes (builtins.fromJSON (builtins.readFile ./packages/ml-dsa/wasm/sizes.json));
      pnpmVersion = lib.pnpmVersion (builtins.fromJSON (builtins.readFile ./package.json)).packageManager or null;

      # Fixed names keep the store paths the same after a `git mv`.
      vendoredSource = builtins.path {
        path = ./vendor/mldsa-native;
        name = "mldsa-native";
      };
      include = builtins.path {
        path = ./packages/ml-dsa/wasm/include;
        name = "mldsa-wasm-include";
      };

      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];

      # Runs build.sh in `mode`: `build` for the module and its twin, or
      # `debug` for the -g module that the check command's path scan reads.
      wasm =
        {
          name,
          mode,
          system,
          pkgs,
          llvm,
        }:
        # A bare derivation runs no stdenv phases or setup hooks, and the
        # unwrapped clang adds no flags of its own, so build.sh holds every
        # flag.
        derivation {
          inherit name system;
          builder = "${pkgs.bash}/bin/bash";
          args = [
            ./packages/ml-dsa/wasm/build.sh
            mode
          ];
          PATH = "${pkgs.coreutils}/bin";
          CC = "${llvm.clang-unwrapped}/bin/clang";
          WASM_LD = "${llvm.lld}/bin/wasm-ld";
          MLDSA_NATIVE = vendoredSource;
          INCLUDE = include;
          MEMORY_SIZE = toString sizes.memoryBytes;
          STACK_SIZE = toString sizes.stackBytes;
          # The module must name no store path.
          allowedReferences = [ ];
        };
    in
    {
      packages = builtins.listToAttrs (
        map (
          system:
          let
            pkgs = import nixpkgs {
              inherit system;
              config = { };
              overlays = [ ];
            };
            llvm = pkgs.llvmPackages_22;
          in
          {
            name = system;
            value = {
              wasm = wasm {
                name = "mldsa-wasm";
                mode = "build";
                inherit system pkgs llvm;
              };
              wasm-debug = wasm {
                name = "mldsa-wasm-debug";
                mode = "debug";
                inherit system pkgs llvm;
              };
              # The clang that compiles the module. The check command runs it
              # to probe upstream's headers and reads its version.
              clang = llvm.clang-unwrapped;
              # The tools that the check command's feature probe runs with the
              # pinned clang: wasm-ld, llc, and the validator.
              lld = llvm.lld;
              llvm = llvm.llvm;
              wasm-tools = pkgs.wasm-tools;
              # The Node.js and the pnpm that pack the npm tarball inside the
              # container. The dev tools need a Node.js in the root
              # package.json's devEngines range.
              nodejs = pkgs.nodejs_24;
              pnpm = import ./nix/pnpm.nix {
                inherit pkgs system;
                version = pnpmVersion;
              };
            };
          }
        ) systems
      );
    };
}
