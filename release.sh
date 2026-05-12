#!/usr/bin/env bash
set -euo pipefail

# MoxMox Release Script
# Creates a git tag, builds the extension for Chrome and Firefox,
# signs the Firefox extension via AMO, packages release assets,
# and creates a draft GitHub release.
#
# By default, increments the minor version (e.g. v0.1.0 → v0.2.0).
# Use --patch to increment only the patch version (e.g. v0.1.0 → v0.1.1).
# Use --nobump/--no-bump to release the current manifest version.
# Use --dryrun to preview what would happen without making any changes.
#
# Required environment variables:
#   AMO_JWT_ISSUER       — AMO API key
#   AMO_JWT_SECRET       — AMO API secret
#
# Usage:
#   ./release.sh                        # bump minor version
#   ./release.sh --patch                # bump patch version
#   ./release.sh --nobump               # release current version
#   ./release.sh --dryrun               # preview minor bump

# --- Argument parsing ---

BUMP="minor"
NO_BUMP=false
DRYRUN=false
for arg in "$@"; do
  case "$arg" in
    --patch) BUMP="patch" ;;
    --nobump|--no-bump) NO_BUMP=true ;;
    --dryrun) DRYRUN=true ;;
    *)
      echo "Usage: $0 [--patch | --nobump] [--dryrun]"
      echo "  Unknown argument: $arg"
      exit 1
      ;;
  esac
done

if [[ "$NO_BUMP" == true && "$BUMP" != "minor" ]]; then
  echo "Error: --nobump cannot be combined with --patch"
  echo "Usage: $0 [--patch | --nobump] [--dryrun]"
  exit 1
fi

# Read current version from manifests/base.json
CURRENT=$(node -e "import{readFileSync as r}from'fs';console.log(JSON.parse(r('manifests/base.json','utf8')).version)")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

if [[ "$NO_BUMP" == true ]]; then
  VERSION="$CURRENT"
  BUMP_LABEL="no version bump"
elif [[ "$BUMP" == "patch" ]]; then
  VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
  BUMP_LABEL="$BUMP bump"
else
  VERSION="${MAJOR}.$((MINOR + 1)).0"
  BUMP_LABEL="$BUMP bump"
fi

TAG="v${VERSION}"
CHROME_ZIP=""
FIREFOX_XPI=""
UPDATE_MANIFEST=""
UPDATE_MANIFEST_NAME="moxmox-firefox-updates.json"
UNSIGNED_FIREFOX_ZIP=""
VERSION_FILES_UPDATED=false
RELEASE_COMMIT_CREATED=false
TAG_CREATED=false
TAG_PUSHED=false
MAIN_PUSHED=false
RELEASE_CREATED=false
CLEANUP_ACTIVE=false

echo "Current version: $CURRENT → releasing $TAG ($BUMP_LABEL)"

if $DRYRUN; then
  echo ""
  echo "[dry run] Would create tag: $TAG"
  echo "[dry run] Would build Chrome and Firefox extensions"
  echo "[dry run] Would sign Firefox extension via AMO (unlisted)"
  echo "[dry run] Would create: moxmox-chrome-${TAG}.zip, moxmox-firefox-${TAG}.xpi, $UPDATE_MANIFEST_NAME"
  echo "[dry run] Would create draft GitHub release with all assets"
  echo ""
  echo "[dry run] No changes made."
  exit 0
fi

# --- Preflight checks ---

if ! command -v gh &>/dev/null; then
  echo "Error: GitHub CLI (gh) is required. Install it: https://cli.github.com"
  exit 1
fi

if ! command -v zip &>/dev/null; then
  echo "Error: zip is required."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "Error: node is required."
  exit 1
fi

# Check store credentials
missing=()
[[ -z "${AMO_JWT_ISSUER:-}" ]] && missing+=("AMO_JWT_ISSUER")
[[ -z "${AMO_JWT_SECRET:-}" ]] && missing+=("AMO_JWT_SECRET")
if (( ${#missing[@]} > 0 )); then
  echo "Error: missing required environment variables:"
  printf '  %s\n' "${missing[@]}"
  echo ""
  echo "AMO credentials: https://addons.mozilla.org/developers/addon/api/key/"
  exit 1
fi

# Ensure we're in the repo root
if [[ ! -f manifests/base.json ]]; then
  echo "Error: must be run from the moxmox repo root (manifests/base.json not found)"
  exit 1
fi

# Check we're on the main branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on the main branch to release (currently on: $BRANCH)"
  exit 1
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: you have uncommitted changes. Please commit or stash them first."
  exit 1
fi

# Check tag doesn't already exist
if git rev-parse "$TAG" &>/dev/null; then
  echo "Error: tag $TAG already exists."
  exit 1
fi

write_version_files() {
  local target_version="$1"
  node - "$target_version" <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'fs';

const version = process.argv[2];

function updateJson(path, update) {
  if (!existsSync(path)) return false;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  update(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${path} ✓`);
  return true;
}

updateJson('manifests/base.json', json => {
  json.version = version;
});
updateJson('package.json', json => {
  json.version = version;
});
updateJson('package-lock.json', json => {
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version;
});
NODE
}

cleanup_on_error() {
  local status=$?
  if [[ "$status" -eq 0 || "$CLEANUP_ACTIVE" != true ]]; then
    return
  fi

  trap - EXIT
  set +e

  echo ""
  echo "Release failed; cleaning up..."

  [[ -n "$CHROME_ZIP" ]] && rm -f "$CHROME_ZIP"
  [[ -n "$FIREFOX_XPI" ]] && rm -f "$FIREFOX_XPI"
  [[ -n "$UPDATE_MANIFEST" ]] && rm -f "$UPDATE_MANIFEST"
  [[ -n "$UNSIGNED_FIREFOX_ZIP" ]] && rm -f "$UNSIGNED_FIREFOX_ZIP"
  rm -rf web-ext-artifacts/

  if [[ "$TAG_CREATED" == true ]]; then
    if [[ "$RELEASE_CREATED" == true ]]; then
      echo "Deleting draft release $TAG if it was created..."
      gh release delete "$TAG" --repo natefinch/moxmox --yes --cleanup-tag >/dev/null 2>&1 || true
    fi

    echo "Removing local tag $TAG..."
    git tag -d "$TAG" >/dev/null 2>&1 || true

    echo "Removing remote tag $TAG if it was pushed..."
    git push origin ":refs/tags/$TAG" >/dev/null 2>&1 || true
  fi

  if [[ "$RELEASE_COMMIT_CREATED" == true && "$MAIN_PUSHED" != true ]]; then
    echo "Removing local release commit..."
    git reset --mixed HEAD~1 >/dev/null 2>&1 || true
    RELEASE_COMMIT_CREATED=false
  fi

  if [[ "$VERSION_FILES_UPDATED" == true ]]; then
    echo "Restoring version files to $CURRENT..."
    write_version_files "$CURRENT" >/dev/null || true
  fi

  if [[ "$MAIN_PUSHED" == true ]]; then
    echo "Warning: main was already pushed before the failure; local version files were restored, but remote main may still contain the release commit."
  fi

  exit "$status"
}

CLEANUP_ACTIVE=true
trap cleanup_on_error EXIT

# --- Update version ---

if [[ "$NO_BUMP" == true ]]; then
  echo "Skipping version update (--nobump)."
else
  echo "Updating version to $VERSION..."
  write_version_files "$VERSION"
  VERSION_FILES_UPDATED=true
fi

# --- Build ---

echo "Building extensions..."
node build.js

# --- Package Chrome zip ---

CHROME_ZIP="moxmox-chrome-${TAG}.zip"

echo "Packaging $CHROME_ZIP..."
(cd dist/chrome && COPYFILE_DISABLE=1 zip -r -X "../../$CHROME_ZIP" . -x '__MACOSX/*' '*/.*' '.*')
echo "  $(du -h "$CHROME_ZIP" | cut -f1) $CHROME_ZIP"

# --- Sign Firefox extension via AMO ---

FIREFOX_XPI="moxmox-firefox-${TAG}.xpi"
UNSIGNED_FIREFOX_ZIP="moxmox-firefox-unsigned-${TAG}.zip"

echo "Signing Firefox extension via AMO (unlisted)..."
(cd dist/firefox && COPYFILE_DISABLE=1 zip -r -X "../../$UNSIGNED_FIREFOX_ZIP" . -x '__MACOSX/*' '*/.*' '.*')
if ! node scripts/sign-firefox.mjs \
    --input "$UNSIGNED_FIREFOX_ZIP" \
    --source-dir dist/firefox \
    --output "$FIREFOX_XPI" \
    --artifacts-dir web-ext-artifacts; then
  rm -f "$UNSIGNED_FIREFOX_ZIP"
  exit 1
fi
rm "$UNSIGNED_FIREFOX_ZIP"
echo "  $(du -h "$FIREFOX_XPI" | cut -f1) $FIREFOX_XPI"

echo "Writing Firefox update manifest..."
UPDATE_MANIFEST="$UPDATE_MANIFEST_NAME"
node - "$VERSION" "$TAG" "$FIREFOX_XPI" "$UPDATE_MANIFEST" <<'NODE'
import { writeFileSync } from 'fs';

const [version, tag, xpiName, output] = process.argv.slice(2);
const updateManifest = {
  addons: {
    'moxmox@natefinch.com': {
      updates: [
        {
          version,
          update_link: `https://github.com/natefinch/moxmox/releases/download/${tag}/${xpiName}`,
        },
      ],
    },
  },
};

writeFileSync(output, JSON.stringify(updateManifest, null, 2) + '\n');
NODE
echo "  $UPDATE_MANIFEST"

# --- Commit version bump & tag ---

if [[ "$NO_BUMP" == true ]]; then
  echo "Skipping version bump commit (--nobump)."
else
  git add manifests/base.json package.json
  [[ -f package-lock.json ]] && git add package-lock.json
  git commit -m "Release $TAG"
  RELEASE_COMMIT_CREATED=true
fi
git tag -a "$TAG" -m "Release $TAG"
TAG_CREATED=true

echo "Created tag $TAG"

# --- Push tag and create draft release ---

echo "Pushing tag to origin..."
git push origin "$TAG"
TAG_PUSHED=true

echo "Creating draft release on GitHub..."
gh release create "$TAG" "$CHROME_ZIP" "$FIREFOX_XPI" "$UPDATE_MANIFEST" \
  --repo natefinch/moxmox \
  --title "MoxMox $TAG" \
  --notes "## Installation

### Chrome
1. Download **${CHROME_ZIP}** below
2. Unzip it to a folder
3. Open Chrome → \`chrome://extensions\`
4. Enable **Developer mode**
5. Click **Load unpacked** and select the unzipped folder

### Firefox
1. Download **${FIREFOX_XPI}** below
2. Open Firefox → \`about:addons\`
3. Click the gear icon (⚙) → **Install Add-on From File…**
4. Select the downloaded \`.xpi\` file

Firefox installs from v${VERSION} onward include automatic update metadata for future GitHub releases." \
  --draft
RELEASE_CREATED=true

echo "Pushing main to origin..."
git push origin main
MAIN_PUSHED=true

# --- Cleanup ---

rm "$CHROME_ZIP" "$FIREFOX_XPI" "$UPDATE_MANIFEST"
CLEANUP_ACTIVE=false
trap - EXIT

echo ""
echo "Done! Draft release $TAG created at:"
echo "  https://github.com/natefinch/moxmox/releases/tag/$TAG"
echo ""
echo "Go to that URL to review and publish the release."
