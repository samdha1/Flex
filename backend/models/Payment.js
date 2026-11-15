const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  freelancer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  amount: { type: Number, required: true },
  platformFee: { type: Number, default: 0 },
  netAmount: { type: Number, required: true },
  
  type: { type: String, enum: ['escrow_fund', 'milestone_release', 'refund', 'platform_fee'], required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'refunded'], default: 'pending' },
  
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  
  description: { type: String },
  
  createdAt: { type: Date, default: Date.now }
});

paymentSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ client: 1, createdAt: -1 });
paymentSchema.index({ freelancer: 1, createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
