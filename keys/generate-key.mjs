// =============================================================================
// QStore V2 -- License key generator
// =============================================================================
// Usage:
//   node keys/generate-key.mjs --unit="Unit Name" [--sub=slug] [--tier=lifetime] [--exp=YYYY-MM-DD]
//
// For a lifetime key omit --exp (defaults to 2099-12-31).
// The private key is read from keys/private.key (hex, gitignored).
// The public key must be set in src/license.js PRODUCTION_PUBLIC_KEY_HEX.
//
// To generate a new keypair (first time only):
//   node keys/generate-key.mjs --generate-keypair
// =============================================================================

import { ed25519 } from '@noble/curves/ed25519.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIV_FILE = join(__dirname, 'private.key');
const PUB_FILE  = join(__dirname, 'public.key');

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

function b64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToB64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return b64urlEncode(str);
}

const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function bytesToBase32(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_CHARS[(value << (5 - bits)) & 31];
  return output;
}

function toHumanKey(rawKey) {
  const bytes = new TextEncoder().encode(rawKey);
  const b32   = bytesToBase32(bytes);
  const chunks = b32.match(/.{1,5}/g) || [];
  return 'QSTRE-' + chunks.join('-');
}

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    })
);

if (args['generate-keypair']) {
  if (existsSync(PRIV_FILE)) {
    console.error('ERROR: private.key already exists. Delete it manually to regenerate.');
    process.exit(1);
  }
  const privKey = ed25519.utils.randomSecretKey();
  const pubKey  = ed25519.getPublicKey(privKey);
  writeFileSync(PRIV_FILE, bytesToHex(privKey), 'utf8');
  writeFileSync(PUB_FILE,  bytesToHex(pubKey),  'utf8');
  console.log('=== KEYPAIR GENERATED ===');
  console.log('Private key saved to: keys/private.key  (KEEP SECURE -- NEVER COMMIT)');
  console.log('Public key saved to:  keys/public.key');
  console.log('');
  console.log('Public key (hex):');
  console.log(bytesToHex(pubKey));
  console.log('');
  console.log('Paste this into src/license.js PRODUCTION_PUBLIC_KEY_HEX');
  process.exit(0);
}

if (!existsSync(PRIV_FILE)) {
  console.error('ERROR: keys/private.key not found. Run: node keys/generate-key.mjs --generate-keypair');
  process.exit(1);
}

const unit = args.unit;
const sub  = args.sub || (unit ? unit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'') : null);
const tier = args.tier || 'lifetime';

if (!unit) {
  console.error('Usage: node keys/generate-key.mjs --unit="Unit Name" [--sub=slug] [--tier=lifetime] [--exp=YYYY-MM-DD]');
  process.exit(1);
}

const expDate = args.exp ? new Date(args.exp + 'T00:00:00Z') : new Date('2099-12-31T00:00:00Z');
const exp = Math.floor(expDate.getTime() / 1000);
const iat = Math.floor(Date.now() / 1000);

const payload    = { sub, unit, tier, iat, exp };
const payloadB64 = b64urlEncode(JSON.stringify(payload));

const privKeyHex = readFileSync(PRIV_FILE, 'utf8').trim();
const privKey    = hexToBytes(privKeyHex);

const msg      = new TextEncoder().encode(payloadB64);
const sig      = ed25519.sign(msg, privKey);
const sigB64   = bytesToB64url(sig);
const rawKey   = payloadB64 + '.' + sigB64;
const humanKey = toHumanKey(rawKey);

console.log('=== LICENSE KEY GENERATED ===');
console.log('Unit:    ' + unit);
console.log('Sub:     ' + sub);
console.log('Tier:    ' + tier);
console.log('Expires: ' + expDate.toISOString().slice(0, 10) + (tier === 'lifetime' ? ' (lifetime)' : ''));
console.log('');
console.log('Human key (enter this in Settings > Subscription):');
console.log(humanKey);
console.log('');
console.log('Raw key (for automated activation):');
console.log(rawKey);
