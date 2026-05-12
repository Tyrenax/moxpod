#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { JwtApiAuth, signAddon } from 'web-ext/util/submit-addon';

const AMO_BASE_URL = 'https://addons.mozilla.org/api/v5/';
const JWT_EXPIRES_IN_SECONDS = 60;
const webExtPackage = JSON.parse(
  readFileSync(new URL('../node_modules/web-ext/package.json', import.meta.url), 'utf8'),
);

class ShortLivedJwtApiAuth extends JwtApiAuth {
  constructor({ apiKey, apiSecret }) {
    super({ apiKey, apiSecret, apiJwtExpiresIn: JWT_EXPIRES_IN_SECONDS });
  }
}

function usage() {
  console.error('Usage: node scripts/sign-firefox.mjs --input <unsigned.zip> --source-dir <dist/firefox> --output <signed.xpi> [--artifacts-dir <dir>]');
}

function parseArgs(argv) {
  const args = {
    artifactsDir: 'web-ext-artifacts',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[++i];
      if (!value) {
        usage();
        process.exit(1);
      }
      return value;
    };
    switch (arg) {
      case '--input':
        args.input = readValue();
        break;
      case '--source-dir':
        args.sourceDir = readValue();
        break;
      case '--output':
        args.output = readValue();
        break;
      case '--artifacts-dir':
        args.artifactsDir = readValue();
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        usage();
        process.exit(1);
    }
  }
  if (!args.input || !args.sourceDir || !args.output) {
    usage();
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.AMO_JWT_ISSUER;
const apiSecret = process.env.AMO_JWT_SECRET;
if (!apiKey || !apiSecret) {
  console.error('Error: AMO_JWT_ISSUER and AMO_JWT_SECRET are required.');
  process.exit(1);
}

const artifactsDir = resolve(args.artifactsDir);
rmSync(artifactsDir, { recursive: true, force: true });
mkdirSync(artifactsDir, { recursive: true });

const result = await signAddon({
  apiKey,
  apiSecret,
  amoBaseUrl: AMO_BASE_URL,
  id: 'moxmox@natefinch.com',
  xpiPath: resolve(args.input),
  downloadDir: artifactsDir,
  channel: 'unlisted',
  savedIdPath: join(resolve(args.sourceDir), '.web-extension-id'),
  savedUploadUuidPath: join(resolve(args.sourceDir), '.amo-upload-uuid'),
  userAgentString: `web-ext/${webExtPackage.version}`,
  ApiAuthClass: ShortLivedJwtApiAuth,
});

const signedFile = result.downloadedFiles?.find(file => file.endsWith('.xpi'));
if (!signedFile) {
  console.error('Error: AMO signing did not produce a signed .xpi file.');
  process.exit(1);
}

renameSync(join(artifactsDir, signedFile), resolve(args.output));
rmSync(artifactsDir, { recursive: true, force: true });
