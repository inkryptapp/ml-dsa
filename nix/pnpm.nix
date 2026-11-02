# The pnpm that installs the dev tools inside the build container, so that the
# check command can pack the npm tarball there. The pnpm that the root
# package.json pins ships only a native binary, which names the glibc loader
# at its usual Linux path. The build image lacks that path, so this derivation
# points the binary at Nix's loader and libraries, and changes nothing else in
# it.
#
# Each pnpm version needs its two tarball hashes in the table below. npm prints
# each one with `npm view @pnpm/exe.<platform>@<version> dist.integrity`.
{
  pkgs,
  system,
  version,
}:
let
  platforms = {
    aarch64-linux = "linux-arm64";
    x86_64-linux = "linux-x64";
  };
  hashes = {
    "12.16.1" = {
      aarch64-linux = "sha512-JaRd5gNxwdNGBBkrZFt8bknrK4YmHVJBW0JMhUQ0fJ0dEYp6C2GT9ExaCqOO8EwYEyqM+jpKgJIK+8WFaJy3ew==";
      x86_64-linux = "sha512-RK//8ZLcXGW8A2k8bQOXZDBN1Qu92zN4dYnG1bzj1zoQ1fkZ6jNzZ1AvXtsfGVma795CJtvoaF5bLXf4l/FIUw==";
    };
  };
  platform = platforms.${system};
  hash =
    (hashes.${version}
      or (throw "nix/pnpm.nix has no hashes for pnpm ${version}, which the root package.json's packageManager field names.")
    ).${system};
in
pkgs.stdenv.mkDerivation {
  pname = "pnpm";
  inherit version;
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@pnpm/exe.${platform}/-/exe.${platform}-${version}.tgz";
    inherit hash;
  };
  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [ pkgs.stdenv.cc.cc.lib ];
  dontBuild = true;
  dontStrip = true;
  installPhase = ''
    install -D -m 755 pnpm $out/bin/pnpm
  '';
}
