// =============================================================================
// QStore IMS — Beta Tester Lifetime Key Tool
// =============================================================================
// Internal admin use only. Not for public disclosure.
//
// Usage:
//   node admin/grant-lifetime.mjs --email="tester@unit.gov.au" --name="John Smith" --unit="145 ACU"
//   node admin/grant-lifetime.mjs --email="..." --name="..." --unit="..." --no-email
//   node admin/grant-lifetime.mjs --list
//
// Config (admin/.env or environment):
//   RESEND_API_KEY   — Resend API key for email delivery (re_...)
//   FROM_EMAIL       — sender address (default: hello@itemora.com)
//
// The key is self-verifying (Ed25519 signature). No platform-core connection required.
// All issued keys are logged to admin/issued-keys.log (gitignored).
// =============================================================================

import { createPrivateKey, sign } from 'crypto';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIV_FILE  = join(__dirname, '..', 'keys', 'private.key');
const LOG_FILE   = join(__dirname, 'issued-keys.log');
const ENV_FILE   = join(__dirname, '.env');

// ── Load local .env if present ────────────────────────────────────────────────

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"#\n]+)"?/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ── Args ──────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    })
);

// ── --list ────────────────────────────────────────────────────────────────────

if (args.list) {
  if (!existsSync(LOG_FILE)) {
    console.log('No keys issued yet.');
  } else {
    console.log(readFileSync(LOG_FILE, 'utf8'));
  }
  process.exit(0);
}

// ── Validate required args ────────────────────────────────────────────────────

const email = args.email;
const name  = args.name;
const unit  = args.unit ?? name;

if (!email || !name) {
  console.error('Usage: node admin/grant-lifetime.mjs --email="..." --name="..." [--unit="..."] [--no-email]');
  process.exit(1);
}

if (!existsSync(PRIV_FILE)) {
  console.error('ERROR: keys/private.key not found.');
  process.exit(1);
}

// ── Ed25519 key generation ────────────────────────────────────────────────────

const ED25519_PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
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
  const b32   = bytesToBase32(Buffer.from(rawKey));
  const chunks = b32.match(/.{1,5}/g) ?? [];
  return 'QSTRE-' + chunks.join('-');
}

function generateKey(unit, name) {
  const privKeyHex = readFileSync(PRIV_FILE, 'utf8').trim();
  const iat = Math.floor(Date.now() / 1000);
  const exp = Math.floor(new Date('2099-12-31T00:00:00Z').getTime() / 1000);
  const sub = unit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const payload    = { sub, unit, tier: 'lifetime', iat, exp };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const privKeyObj = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_HEADER, Buffer.from(privKeyHex, 'hex')]),
    format: 'der',
    type:   'pkcs8',
  });

  const sig    = sign(null, Buffer.from(payloadB64), privKeyObj);
  const rawKey = payloadB64 + '.' + sig.toString('base64url');

  return { rawKey, humanKey: toHumanKey(rawKey), payload };
}

// ── Email via Resend ──────────────────────────────────────────────────────────

async function sendEmail(to, firstName, humanKey) {
  const apiKey  = process.env.RESEND_API_KEY;
  const from    = process.env.FROM_EMAIL ?? 'hello@itemora.com';

  if (!apiKey) {
    console.warn('  RESEND_API_KEY not set — skipping email (set in admin/.env)');
    return false;
  }

  const html = buildEmail(firstName, humanKey);

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to,
      subject: 'Your QStore IMS Lifetime Licence — ITEMORA',
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.warn(`  Email failed (${res.status}): ${body}`);
    return false;
  }

  return true;
}

function buildEmail(firstName, humanKey) {
  const portalUrl = 'https://portal.woodifi.com.au';
  return `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
      <tr><td style="background:#1B1F24;padding:20px 40px 20px 40px;">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="background:#708C3A;border-radius:6px;padding:6px 10px;">
            <span style="color:#fff;font-size:11px;font-weight:700;">&#9632;</span>
          </td>
          <td style="padding-left:10px;">
            <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:1px;font-family:'Montserrat','Arial',sans-serif;">ITEMORA</span>
          </td>
        </tr></table>
        <p style="color:#9BA5B0;font-size:11px;margin:6px 0 0;">QStore IMS &mdash; SEE IT. TRACK IT. OWN IT.</p>
      </td></tr>
      <tr><td style="background:#708C3A;height:3px;font-size:0;">&nbsp;</td></tr>
      <tr><td style="padding:40px;">
        <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#1B1F24;">Your lifetime licence key</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">
          Hi ${firstName}, you've been granted a <strong>lifetime licence</strong> for QStore IMS as a thank-you for your contribution as a beta tester. This key never expires.
        </p>
        <div style="background:#f4f4f5;border:1px solid #e4e4e7;border-left:4px solid #708C3A;border-radius:6px;padding:16px;margin:16px 0;font-family:'Courier New',monospace;font-size:14px;letter-spacing:1px;color:#1B1F24;word-break:break-all;">
          ${humanKey}
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:#71717a;">To activate:</p>
        <ol style="margin:0 0 24px;padding-left:20px;font-size:14px;line-height:2;color:#3f3f46;">
          <li>Download QStore IMS from your <a href="${portalUrl}/downloads" style="color:#708C3A;">portal</a></li>
          <li>Open the file in your browser</li>
          <li>Go to <strong>Settings → Subscription</strong> and paste the key above</li>
        </ol>
        <a href="${portalUrl}/downloads" style="display:inline-block;background:#708C3A;color:#fff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;">
          Go to Portal
        </a>
        <p style="margin:24px 0 0;font-size:13px;color:#71717a;">
          <strong>Keep this key safe</strong> — it is your lifetime proof of purchase. Reply to this email if you need any help getting set up.
        </p>
      </td></tr>
      <tr><td style="background:#f4f4f5;padding:20px 40px;border-top:1px solid #e4e4e7;">
        <p style="margin:0;color:#71717a;font-size:12px;">
          ITEMORA Pty Ltd &middot; <a href="mailto:hello@itemora.com" style="color:#71717a;">hello@itemora.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── Audit log ─────────────────────────────────────────────────────────────────

function logIssued(email, name, unit, humanKey, emailSent) {
  const ts  = new Date().toISOString();
  const row = `${ts} | ${name} | ${unit} | ${email} | email_sent=${emailSent} | ${humanKey}\n`;
  appendFileSync(LOG_FILE, row, 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { humanKey, payload } = generateKey(unit, name);
const sendMail = !args['no-email'];

console.log('\n=== BETA TESTER LIFETIME KEY ===');
console.log(`Recipient : ${name} <${email}>`);
console.log(`Unit      : ${unit}`);
console.log(`Tier      : lifetime`);
console.log(`Expires   : 2099-12-31 (never)`);
console.log(`Issued    : ${new Date().toLocaleDateString('en-AU')}`);
console.log('');
console.log('Human key (enter in Settings → Subscription):');
console.log(`  ${humanKey}`);
console.log('');

let emailSent = false;
if (sendMail) {
  process.stdout.write('Sending email... ');
  try {
    emailSent = await sendEmail(email, name.split(' ')[0], humanKey);
    console.log(emailSent ? 'sent ✓' : 'failed (key printed above — deliver manually)');
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
} else {
  console.log('(--no-email: email skipped — deliver key manually)');
}

logIssued(email, name, unit, humanKey, emailSent);
console.log(`\nLogged to: admin/issued-keys.log`);
