const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  // SHA-256 digest of the 6-digit code. The plaintext code is only ever sent by email.
  code: { type: String, required: true },
  attempts: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, default: Date.now, expires: '10m' }, // Expires in 10 mins
});

// Verification looks the record up by email, so keep that lookup indexed.
otpSchema.index({ email: 1 });

module.exports = mongoose.model('OTP', otpSchema);
