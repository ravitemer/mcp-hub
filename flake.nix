{
  description = "A manager server for MCP servers that handles process management and tool routing";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
  };

  outputs = inputs@{ self, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      perSystem = { pkgs, ... }:
        let
          nodejs = pkgs.nodejs_18;

          npmDeps = pkgs.fetchNpmDeps {
            name = "mcp-hub-deps";
            src = self;
            hash = "sha256-zmOGESo28HSUk3vSOEplpWIyn9m3U/W6qPeZaJjx1iE=";
          };

          mcp-hub = pkgs.stdenv.mkDerivation {
            pname = "mcp-hub";
            version = "1.7.3";
            src = self;

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
        in
        {
          packages = {
            default = mcp-hub;
            mcp-hub = mcp-hub;
          };

          devShells.default = pkgs.mkShell {
            buildInputs = [ nodejs ];
          };
        };
    };
}
