{ pkgs, src, revision ? null, sourceHash }:

let
  bunDeps = import ./bun-deps.nix { inherit pkgs; };
  version = (builtins.fromJSON (builtins.readFile (src + "/package.json"))).version;
  revisionLiteral = if revision == null then "null" else ''"${revision}"'';
  identitySource = pkgs.writeText "skillful-build-identity.ts" ''
    export const revision: string | null = ${revisionLiteral};
    export const sourceHash: string | null = "${sourceHash}";
  '';
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "skillful";
  inherit version src;
  nativeBuildInputs = [ pkgs.bun ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    cp ${identitySource} cli/build-identity.ts
    NODE_PATH=${bunDeps} bun build --compile cli/main.ts --outfile skillful
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 skillful "$out/bin/skillful"
    runHook postInstall
  '';
  meta = {
    mainProgram = "skillful";
    description = "Author agent skills once, render them per harness";
  };
}
