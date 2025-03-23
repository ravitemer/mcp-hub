{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        nodejs = pkgs.nodejs_18;

        npmDeps = pkgs.fetchNpmDeps {
          name = "mcp-hub-deps";
          src = ./.;
          hash = "sha256-zmOGESo28HSUk3vSOEplpWIyn9m3U/W6qPeZaJjx1iE=";
        };
      in
      {
        packages = {
          default = pkgs.stdenv.mkDerivation {
            pname = "mcp-hub";
            version = "1.7.3";
            src = ./.;

            nativeBuildInputs = [ nodejs ];

            npmDeps = npmDeps;

            configurePhase = ''
              export HOME=$(mktemp -d)
              npm config set offline true
              npm config set prefer-offline true
              npm config set fetch-retries 0
              npm config set cache $HOME/.npm

              mkdir -p $HOME/.npm
              cp -r $npmDeps/* $HOME/.npm/
            '';

            buildPhase = ''
              runHook preBuild

              npm ci --offline --prefer-offline --no-audit --ignore-scripts
              npm run build

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/bin
              cp dist/cli.js $out/bin/mcp-hub
              chmod +x $out/bin/mcp-hub

              runHook postInstall
            '';
          };
        };

        devShell = pkgs.mkShell {
          buildInputs = [
            nodejs
            pkgs.vitest
          ];
        };
      }
    );
}
