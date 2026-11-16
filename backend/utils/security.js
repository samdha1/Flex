const crypto = require('crypto');

// Compares two strings without leaking their contents through timing.
const safeCompareText = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
};

// OTP codes are short lived and low entropy, so they are stored as a digest
// instead of plaintext to keep valid codes out of database dumps and backups.
const hashOtpCode = (code) => crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');

const JWT_SECRET_MIN_LENGTH = 32;

const assertJwtSecret = (secret) => {
  if (typeof secret !== 'string' || !secret) {
    throw new Error('JWT_SECRET must be set in all environments before starting the server.');
  }
  const isPlaceholder = /change|example|secret_key|your[_-]/i.test(secret);
  if (secret.length < JWT_SECRET_MIN_LENGTH || isPlaceholder) {
    throw new Error(
      `JWT_SECRET must be a unique random value of at least ${JWT_SECRET_MIN_LENGTH} characters. `
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
};

// Used to keep login timing comparable when the email does not exist.
const DUMMY_PASSWORD_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8LdQ0e4nZ3z3Gq3x4oYb1Xz7fBL0Wa';

module.exports = {
  safeCompareText,
  hashOtpCode,
  assertJwtSecret,
  DUMMY_PASSWORD_HASH,
  JWT_SECRET_MIN_LENGTH,
};
