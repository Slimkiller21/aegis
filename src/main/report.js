// Weekly accountability report for the user's partner.
//
// PRIVACY: the email contains ONLY aggregate accountability numbers — current
// streak, blocks this week, longest streak, next milestone. It NEVER contains a
// screenshot, URL, filename, or any captured content. Screen frames still never
// leave the device; this is opt-in stats only.
//
// Delivery is SMTP via nodemailer using a dedicated email account the user (or
// ideally the partner) sets up. The app password is stored OS-encrypted
// (Electron safeStorage / Windows DPAPI); we only decrypt it in-memory to send.

function fmtDur(ms) {
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  if (d > 0) return `${d} day${d === 1 ? '' : 's'}${h ? ` ${h}h` : ''}`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

// Build the { subject, text, html } for a partner report from a store snapshot.
function build(snapshot, appName = 'Aegis') {
  const st = snapshot.stats || {};
  const name = (snapshot.profile && snapshot.profile.name) || 'Your partner';
  const streak = fmtDur(st.currentStreakMs || 0);
  const longest = fmtDur(st.longestStreakMs || 0);
  const blocksWk = st.blocksThisWeek || 0;
  const next = st.nextMilestone;
  const date = new Date().toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const subject = `${appName} weekly check-in — ${name}: ${streak} clean`;

  const text = [
    `${appName} — weekly accountability check-in`,
    date,
    '',
    `${name}'s progress this week:`,
    `  • Current clean streak: ${streak}`,
    `  • Content blocked this week: ${blocksWk}`,
    `  • Longest streak so far: ${longest}`,
    next ? `  • Next milestone: ${next.day}-day mark, ${next.daysToGo} day(s) away` : '',
    '',
    `You're receiving this because you're ${name}'s accountability partner in ${appName}.`,
    `This report contains only these numbers — never any images or browsing history.`,
  ].filter((l) => l !== '').join('\n');

  const row = (label, value, accent) =>
    `<tr>
       <td style="padding:10px 0;color:#5b6472;font-size:14px">${label}</td>
       <td style="padding:10px 0;text-align:right;font-weight:700;font-size:16px;color:${accent || '#0f172a'}">${value}</td>
     </tr>`;

  const html = `
  <div style="max-width:520px;margin:0 auto;font-family:'Segoe UI',system-ui,Arial,sans-serif;color:#0f172a">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <span style="display:inline-block;width:26px;height:26px;background:#0b7d5e;border-radius:7px"></span>
      <strong style="font-size:18px">${appName}</strong>
    </div>
    <p style="color:#64748b;font-size:13px;margin:0 0 22px">Weekly accountability check-in · ${date}</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 16px">
      Here's how <strong>${name}</strong> is doing this week. You're their accountability partner.
    </p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e5e9f0">
      ${row('Current clean streak', streak, '#0b7d5e')}
      ${row('Content blocked this week', String(blocksWk))}
      ${row('Longest streak so far', longest)}
      ${next ? row('Next milestone', `${next.day}-day mark · ${next.daysToGo}d to go`) : ''}
    </table>
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:22px 0 0;border-top:1px solid #e5e9f0;padding-top:16px">
      This report contains only these accountability numbers — never any screenshots,
      links, or browsing history. Sent by ${appName}, which runs entirely on ${name}'s device.
    </p>
  </div>`;

  return { subject, text, html };
}

// Encrypt / decrypt the SMTP app password with the OS keystore (lazy-require
// electron so the report builder can be unit-tested without the app running).
function encryptSecret(plain) {
  if (!plain) return '';
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) return '';
  return safeStorage.encryptString(String(plain)).toString('base64');
}
function decryptSecret(b64) {
  if (!b64) return '';
  try {
    const { safeStorage } = require('electron');
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return '';
  }
}

// Send a report over SMTP. `email` is the config.email object; `password` is the
// already-decrypted app password. Returns a promise.
async function send(email, snapshot) {
  const nodemailer = require('nodemailer');
  const password = decryptSecret(email.passEnc);
  if (!email.partnerEmail || !email.senderEmail || !password) {
    throw new Error('email not fully configured');
  }
  const transporter = nodemailer.createTransport({
    host: email.smtpHost || 'smtp.gmail.com',
    port: email.smtpPort || 465,
    secure: email.smtpSecure !== false,
    auth: { user: email.senderEmail, pass: password },
  });
  const { subject, text, html } = build(snapshot);
  await transporter.sendMail({
    from: `Aegis <${email.senderEmail}>`,
    to: email.partnerEmail,
    subject,
    text,
    html,
  });
}

module.exports = { build, send, encryptSecret, decryptSecret };
