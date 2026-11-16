const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // Existing mixed-case user emails must be lowercased once during migration.
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['client', 'freelancer'], required: true },
  avatar: { type: String },
  
  // Profile
  bio: { type: String, maxlength: 1000 },
  location: { type: String, maxlength: 120 },
  phone: { type: String, maxlength: 32 },
  
  // Freelancer specific
  title: { type: String, maxlength: 120 },
  skills: [{ type: String, maxlength: 50 }],
  hourlyRate: { type: Number, min: 0, max: 1000000 },
  availability: { type: String, enum: ['available', 'busy', 'unavailable'], default: 'available' },
  portfolio: [{
    title: { type: String, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    url: { type: String, maxlength: 300 },
  }],
  
  // Client specific
  company: { type: String, maxlength: 120 },
  industry: { type: String, maxlength: 120 },
  
  // Stats
  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  completedProjects: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  
  // App related
  profileCompletion: { type: Number, default: 20 },
  // Tokens issued before this timestamp are rejected, so changing a password
  // signs out every other session.
  passwordChangedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

// Password hashing middleware
userSchema.pre('save', async function(next) {
  this.updateProfileCompletion();
  
  if (!this.isModified('password')) return next();
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  this.passwordChangedAt = new Date();
  next();
});

// True when a token was signed before the last password change.
userSchema.methods.isTokenStale = function(issuedAtSeconds) {
  if (!this.passwordChangedAt || typeof issuedAtSeconds !== 'number') return false;
  // One second of slack covers the gap between hashing and token issuance.
  return this.passwordChangedAt.getTime() / 1000 > issuedAtSeconds + 1;
};

// Match password
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Calculate profile completion
userSchema.methods.updateProfileCompletion = function() {
  let score = 20; // Base score for creating account
  
  if (this.bio) score += 15;
  if (this.location) score += 10;
  if (this.phone) score += 10;
  if (this.avatar) score += 10;
  
  if (this.role === 'freelancer') {
    if (this.skills && this.skills.length > 0) score += 15;
    if (this.title) score += 10;
    if (this.hourlyRate) score += 10;
  } else if (this.role === 'client') {
    if (this.company) score += 15;
    if (this.industry) score += 20;
  }
  
  this.profileCompletion = Math.min(100, score);
};

module.exports = mongoose.model('User', userSchema);
