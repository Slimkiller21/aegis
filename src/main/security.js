// Lock credential (the partner-held password) + the cooldown/lock state that
// makes disabling protection deliberate, not impulsive. scrypt, no deps.

const crypto = require('crypto');
const store = require('./store');

function setPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  const s = store.load();
  s.security = { salt, hash };
  store.save();
}

function hasPassword() {
  const s = store.load();
  return !!(s.security && s.security.hash);
}

function verifyPassword(plain) {
  const s = store.load();
  if (!s.security || !s.security.hash) return false;
  const hash = crypto.scryptSync(String(plain), s.security.salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(s.security.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { setPassword, hasPassword, verifyPassword };
