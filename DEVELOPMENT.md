# MoxMox Development

## Building

```bash
npm install                # install dependencies
node build.js              # build for both browsers → dist/chrome/ and dist/firefox/
node build.js chrome       # build for Chrome only
node build.js firefox      # build for Firefox only
node build.js --watch      # watch mode
node --test tests/*.test.js # run all tests
```

## Server

The relay server is a Cloudflare Worker + Durable Object. See
[server/README.md](server/README.md) for details.

```bash
cd server
npm install
npm run dev      # local development
npm run deploy   # deploy to Cloudflare
```

## Loading the Extension

### Chrome
1. Run `node build.js chrome`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `dist/chrome/`

### Firefox
1. Run `node build.js firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…**
4. Select `dist/firefox/manifest.json`

## Architecture

See [src/README.md](src/README.md) for detailed technical documentation
covering the two-world content script architecture, sync protocol, coordinate
system, and event detection.

## Release

```bash
./release.sh           # bump minor version and create draft release
./release.sh --patch   # bump patch version
./release.sh --nobump  # release the current manifest version
./release.sh --dryrun  # preview without changes
```

Firefox release assets include `moxmox-firefox-updates.json`, which lets
signed Firefox installs update automatically from GitHub releases. Chrome
users who load the unpacked extension still need to replace their local folder
and click **Reload** in `chrome://extensions`.
