# MoxMox

A Chrome and Firefox browser extension.

## Development

```bash
npm install                # install dependencies
node build.js              # build for both browsers → dist/chrome/ and dist/firefox/
node build.js chrome       # build for Chrome only
node build.js firefox      # build for Firefox only
node build.js --watch      # watch mode
node --test tests/*.test.js # run all tests
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

## Release

```bash
./release.sh           # bump minor version and create draft release
./release.sh --patch   # bump patch version
./release.sh --dryrun  # preview without changes
```

## License

MIT — see [LICENSE](LICENSE).
