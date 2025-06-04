#!/usr/bin/env bash
set -e  # Exit on error

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Get the project root (parent directory of scripts/)
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Ensure we're in the project root
cd "$PROJECT_ROOT"

# Ensure we're on main branch
if [[ $(git branch --show-current) != "main" ]]; then
  echo "Error: Must be on main branch"
  exit 1
fi

# Ensure working directory is clean
if [[ -n $(git status -s) ]]; then
  echo "Error: Working directory must be clean"
  exit 1
fi

# Get version type from argument (patch, minor, or major)
VERSION_TYPE=${1:-patch}

# Store original version before any changes
ORIGINAL_VERSION=$(node -p "require('./package.json').version")

# Update version in package.json and package-lock.json without git operations
npm --no-git-tag-version version $VERSION_TYPE

# Get the new version after npm version bump
CURRENT_VERSION=$(node -p "require('./package.json').version")

# Check if CHANGELOG.md exists and contains the new version
if [ -f CHANGELOG.md ]; then
    if ! grep -q "## \[${CURRENT_VERSION}\]" CHANGELOG.md; then
        echo "Error: CHANGELOG.md does not contain documentation for version ${CURRENT_VERSION}"
        echo "Please update CHANGELOG.md before releasing"
        echo "Reverting version changes..."
        # Restore files to their original state
        git checkout package.json package-lock.json
        echo "Reverted package.json and package-lock.json back to version ${ORIGINAL_VERSION}"
        exit 1
    fi
else
    echo "Warning: CHANGELOG.md not found"
    read -p "Continue without CHANGELOG.md? (y/N) " -n 1 -r
    echo    # Move to a new line
    if [[ ! $REPLY =~ ^[Yy]$ ]]
    then
        echo "Reverting version changes..."
        # Restore files to their original state
        git checkout package.json package-lock.json
        echo "Reverted package.json and package-lock.json back to version ${ORIGINAL_VERSION}"
        exit 1
    fi
fi

# Calculate new hash
echo "Calculating npm dependencies hash..."
NEW_HASH=$(nix --extra-experimental-features 'nix-command flakes' run nixpkgs#prefetch-npm-deps -- ./package-lock.json)

# Update both version and hash in flake.nix
echo "Updating flake.nix..."
sed -i "s|version = \"[0-9]*\.[0-9]*\.[0-9]*\"|version = \"$CURRENT_VERSION\"|" flake.nix
sed -i "s|npmDepsHash = \"sha256-[A-Za-z0-9+/]*=\";|npmDepsHash = \"$NEW_HASH\";|" flake.nix

# Create a single commit with all changes
git add package.json package-lock.json flake.nix
git commit -m "chore(release): v${CURRENT_VERSION}"

# Create the tag
git tag -a "v${CURRENT_VERSION}" -m "v${CURRENT_VERSION}"

# Extract changelog for current version
if [ -f CHANGELOG.md ]; then
    # Extract content between current version header and the next header using sed
    RELEASE_NOTES=$(sed -n "/## \[${CURRENT_VERSION}\]/,/## \[/p" CHANGELOG.md | sed -e '1d;$d')
    
    if [ -z "$RELEASE_NOTES" ]; then
        RELEASE_NOTES="Release version ${CURRENT_VERSION}"
    fi
else
    RELEASE_NOTES="Release version ${CURRENT_VERSION}"
fi

# Ask for confirmation before publishing
read -p "Ready to publish v${CURRENT_VERSION} to npm and GitHub. Continue? (y/N) " -n 1 -r
echo    # Move to a new line
if [[ $REPLY =~ ^[Yy]$ ]]
then
    
    echo "Publishing to npm..."
    npm publish --auth-type=legacy
    
    # Push all changes and tags
    git push origin main --tags
    
    # Create GitHub release
    echo "Creating GitHub release..."
    echo "$RELEASE_NOTES" | gh release create "v${CURRENT_VERSION}" --title "v${CURRENT_VERSION}" --notes-file -

    echo "🎉 v${CURRENT_VERSION} release complete!"
else
    # Cleanup if user cancels
    echo "Publishing canceled. Cleaning up..."
    git tag -d "v${CURRENT_VERSION}"
    git reset --hard HEAD~1
    echo "Cleanup complete. No changes were published."
fi
