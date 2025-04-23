{
  description = "A manager server for MCP servers that handles process management and tool routing";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
  };

  outputs = inputs @ {
    self,
    flake-parts,
    ...
  }:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];

      perSystem = {pkgs, ...}: let
        nodejs = pkgs.nodejs_18;

        mcp-hub = pkgs.buildNpmPackage {
          pname = "mcp-hub";
          version = "3.1.1";
          src = self;
          inherit nodejs;

          nativeBuildInputs = [nodejs];
          npmDepsHash = "sha256-7fMv/mje6TcDr4XjrXADOtC+kumisIZVeaWEa8UynoU=";
        };
      in {
        packages = {
          default = mcp-hub;
          mcp-hub = mcp-hub;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [nodejs];
        };
      };
    };
}
