{
  description = "ML-DSA-87 from mldsa-native, compiled to wasm32 with the Matched toolchain";

  inputs = {
    # The Pinned commit: v2.0.0 is 834a90d.
    mldsa-native.url = "github:pq-code-package/mldsa-native/v2.0.0";
    # Upstream's own nixpkgs revision, so clang 22 is the binary upstream's CT tests run (ADR 0001).
    nixpkgs.follows = "mldsa-native/nixpkgs";
  };

  outputs =
    { nixpkgs, mldsa-native, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          name = "mldsa87-wasm";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./build.sh
              ./shim.c
              ./mldsa87_config.h
              ./include
            ];
          };
          # Unwrapped: the cc-wrapper's native include paths and hardening flags don't belong in this build.
          nativeBuildInputs = [
            pkgs.llvmPackages_22.clang-unwrapped
            pkgs.lld_22
          ];
          dontConfigure = true;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            MLDSA_SRC=${mldsa-native}/mldsa OUT=mldsa87.wasm sh ./build.sh
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p $out
            cp mldsa87.wasm $out/
          '';
        };
      });
    };
}
