// =============================================================================
// QStore IMS — Beta Lifetime Key Wizard
// =============================================================================
// Internal admin use only.
// Run: node admin/wizard.mjs
// =============================================================================

import { createInterface }    from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { createPrivateKey, sign } from 'crypto';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath }     from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIV_FILE = join(__dirname, '..', 'keys', 'private.key');
const LOG_FILE  = join(__dirname, 'issued-keys.log');
const ENV_FILE  = join(__dirname, '.env');

// ── Load admin/.env ───────────────────────────────────────────────────────────

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"#\n]+)"?/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ── Terminal helpers ──────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  olive:  '\x1b[33m',
  blue:   '\x1b[36m',
  red:    '\x1b[31m',
  grey:   '\x1b[90m',
  white:  '\x1b[97m',
};

function print(msg = '')         { output.write(msg + '\n'); }
function printDim(msg = '')      { print(C.dim + msg + C.reset); }
function printGreen(msg = '')    { print(C.green + msg + C.reset); }
function printRed(msg = '')      { print(C.red + msg + C.reset); }
function hr()                    { print(C.grey + '─'.repeat(52) + C.reset); }

function banner() {
  print('');
  print(C.bold + C.white + '  QStore IMS — Beta Lifetime Key Wizard' + C.reset);
  print(C.olive + '  ITEMORA · Internal Admin Tool · Not for distribution' + C.reset);
  hr();
}

// ── Readline wrapper ──────────────────────────────────────────────────────────

const rl = createInterface({ input, output, terminal: true });

async function ask(prompt, defaultVal = '') {
  const hint = defaultVal ? C.grey + ` (${defaultVal})` + C.reset : '';
  const answer = await rl.question(`  ${C.bold}${prompt}${C.reset}${hint}: `);
  return answer.trim() || defaultVal;
}

async function confirm(prompt) {
  const answer = await rl.question(`  ${C.bold}${prompt}${C.reset} ${C.grey}[y/N]${C.reset}: `);
  return answer.trim().toLowerCase() === 'y';
}

async function menu(title, items) {
  print('');
  print(`  ${C.bold}${title}${C.reset}`);
  items.forEach((item, i) => {
    print(`  ${C.olive}[${i + 1}]${C.reset}  ${item}`);
  });
  print('');
  const answer = await rl.question(`  Choice: `);
  const n = parseInt(answer.trim(), 10);
  if (isNaN(n) || n < 1 || n > items.length) return null;
  return n - 1;
}

// ── Key generation ────────────────────────────────────────────────────────────

const ED25519_PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function bytesToBase32(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += B32_CHARS[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += B32_CHARS[(value << (5 - bits)) & 31];
  return output;
}

function toHumanKey(raw) {
  const b32 = bytesToBase32(Buffer.from(raw));
  return 'QSTRE-' + (b32.match(/.{1,5}/g) ?? []).join('-');
}

function generateKey(unit) {
  const privKeyHex = readFileSync(PRIV_FILE, 'utf8').trim();
  const iat = Math.floor(Date.now() / 1000);
  const exp = Math.floor(new Date('2099-12-31T00:00:00Z').getTime() / 1000);
  const sub = unit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const payload    = { sub, unit, tier: 'lifetime', iat, exp };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const privKeyObj = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_HEADER, Buffer.from(privKeyHex, 'hex')]),
    format: 'der', type: 'pkcs8',
  });
  const sig    = sign(null, Buffer.from(payloadB64), privKeyObj);
  const rawKey = payloadB64 + '.' + sig.toString('base64url');
  return toHumanKey(rawKey);
}

// ── Email delivery ────────────────────────────────────────────────────────────

async function sendEmail(to, firstName, humanKey) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.FROM_EMAIL ?? 'hello@itemora.com';

  if (!apiKey) {
    printRed('  RESEND_API_KEY not set in admin/.env — email skipped.');
    return false;
  }

  const portalUrl = 'https://portal.woodifi.com.au';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Inter',-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
<tr><td style="background:#1B1F24;padding:20px 40px;">
  <table cellpadding="0" cellspacing="0"><tr>
    <td style="background:#708C3A;border-radius:6px;padding:6px 10px;"><span style="color:#fff;font-size:11px;font-weight:700;">&#9632;</span></td>
    <td style="padding-left:10px;"><span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:1px;">ITEMORA</span></td>
  </tr></table>
  <p style="color:#9BA5B0;font-size:11px;margin:6px 0 0;">QStore IMS &mdash; SEE IT. TRACK IT. OWN IT.</p>
</td></tr>
<tr><td style="background:#708C3A;height:3px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:40px;">
  <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#1B1F24;">Your lifetime licence key</h1>
  <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">
    Hi ${firstName}, you've been granted a <strong>lifetime licence</strong> for QStore IMS as a thank-you for your contribution as a beta tester. This key never expires.
  </p>
  <div style="background:#f4f4f5;border:1px solid #e4e4e7;border-left:4px solid #708C3A;border-radius:6px;padding:16px;margin:16px 0;font-family:'Courier New',monospace;font-size:13px;letter-spacing:0.5px;color:#1B1F24;word-break:break-all;">
    ${humanKey}
  </div>
  <p style="margin:0 0 8px;font-size:13px;color:#71717a;">To activate:</p>
  <ol style="margin:0 0 24px;padding-left:20px;font-size:14px;line-height:2;color:#3f3f46;">
    <li>Download QStore IMS from your <a href="${portalUrl}/downloads" style="color:#708C3A;">portal</a></li>
    <li>Open the file in your browser</li>
    <li>Go to <strong>Settings &rarr; Subscription</strong> and paste the key above</li>
  </ol>
  <a href="${portalUrl}/downloads" style="display:inline-block;background:#708C3A;color:#fff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:6px;text-decoration:none;">Go to Portal</a>
  <p style="margin:24px 0 0;font-size:13px;color:#71717a;"><strong>Keep this key safe</strong> — it is your lifetime proof of purchase.</p>
</td></tr>
<tr><td style="background:#f4f4f5;padding:20px 40px;border-top:1px solid #e4e4e7;">
  <p style="margin:0;color:#71717a;font-size:12px;">ITEMORA Pty Ltd &middot; <a href="mailto:hello@itemora.com" style="color:#71717a;">hello@itemora.com</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify({ from, to, subject: 'Your QStore IMS Lifetime Licence — ITEMORA', html }),
    });
    if (!res.ok) {
      const body = await res.text();
      printRed(`  Email failed (${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    printRed(`  Email error: ${err.message}`);
    return false;
  }
}

// ── View log ──────────────────────────────────────────────────────────────────

function viewLog() {
  print('');
  print(C.bold + '  Issued lifetime keys' + C.reset);
  hr();

  if (!existsSync(LOG_FILE)) {
    printDim('  No keys issued yet.');
    return;
  }

  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    printDim('  No keys issued yet.');
    return;
  }

  lines.forEach((line, i) => {
    const [ts, name, unit, email, emailSent] = line.split(' | ');
    const date = ts ? new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    print(`  ${C.olive}${String(i + 1).padStart(2)}.${C.reset} ${C.bold}${name}${C.reset}  ${C.grey}${unit}${C.reset}`);
    print(`      ${email}  ·  ${date}  ·  ${emailSent}`);
  });

  print('');
  printDim(`  ${lines.length} key${lines.length === 1 ? '' : 's'} issued total.`);
}

// ── Issue flow ────────────────────────────────────────────────────────────────

async function issueFlow(sendMail) {
  print('');
  print(C.bold + '  Recipient details' + C.reset);
  hr();

  const name  = await ask('Full name');
  if (!name) { printRed('  Name is required.'); return; }

  const emailPrompt = sendMail ? 'Email address' : 'Email address (optional)';
  const email = await ask(emailPrompt);
  if (sendMail && (!email || !email.includes('@'))) { printRed('  Valid email is required for delivery.'); return; }

  const unit  = await ask('Unit / organisation', name);

  print('');
  hr();
  print(`  ${C.bold}Confirm${C.reset}`);
  print(`  Name   : ${name}`);
  print(`  Email  : ${email || C.grey + '(not provided)' + C.reset}`);
  print(`  Unit   : ${unit}`);
  print(`  Tier   : ${C.green}lifetime${C.reset} (exp: 2099-12-31)`);
  print(`  Email  : ${sendMail ? C.green + 'will be sent' : C.olive + 'print only'}${C.reset}`);
  print('');

  const ok = await confirm('Issue this key?');
  if (!ok) { printDim('  Cancelled.'); return; }

  print('');
  output.write('  Generating key... ');

  let humanKey;
  try {
    humanKey = generateKey(unit);
    output.write(C.green + 'done\n' + C.reset);
  } catch (err) {
    output.write(C.red + 'failed\n' + C.reset);
    printRed(`  ${err.message}`);
    return;
  }

  let emailSent = false;
  if (sendMail) {
    output.write('  Sending email...   ');
    emailSent = await sendEmail(email, name.split(' ')[0], humanKey);
    output.write(emailSent ? C.green + 'sent ✓\n' + C.reset : C.olive + 'failed — deliver manually\n' + C.reset);
  }

  // Log
  const ts  = new Date().toISOString();
  appendFileSync(LOG_FILE, `${ts} | ${name} | ${unit} | ${email || 'no-email'} | email_sent=${emailSent} | ${humanKey}\n`, 'utf8');

  hr();
  print(C.bold + '  Lifetime key' + C.reset);
  print('');
  // Print key in chunks of ~52 chars for readability
  const chunks = humanKey.match(/.{1,52}/g) ?? [humanKey];
  chunks.forEach(chunk => print(`  ${C.olive}${chunk}${C.reset}`));
  print('');
  printDim('  Logged to admin/issued-keys.log');

  if (!emailSent && email) {
    print('');
    print(`  ${C.bold}Next step:${C.reset} copy the key above and deliver it manually to`);
    print(`  ${email}`);
  } else if (!emailSent) {
    print('');
    printDim('  Copy the key above and deliver it to the recipient.');
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(PRIV_FILE)) {
    banner();
    printRed('  ERROR: keys/private.key not found. Cannot generate keys.');
    rl.close();
    process.exit(1);
  }

  while (true) {
    banner();

    const choice = await menu('What would you like to do?', [
      'Issue lifetime key — send via email',
      'Issue lifetime key — print key only',
      'View all issued keys',
      'Exit',
    ]);

    if (choice === null) {
      printRed('  Invalid choice.');
      continue;
    }

    if (choice === 0) await issueFlow(true);
    if (choice === 1) await issueFlow(false);
    if (choice === 2) viewLog();
    if (choice === 3) break;

    if (choice !== 3) {
      print('');
      await ask('Press Enter to return to menu');
    }
  }

  print('');
  printDim('  Goodbye.');
  print('');
  rl.close();
}

main().catch(err => {
  console.error(err);
  rl.close();
  process.exit(1);
});
