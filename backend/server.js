const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { Server } = require('socket.io');
const User = require('./models/User');
const Conversation = require('./models/Conversation');
const { isValidObjectId } = require('./utils/validate');
const { verifyTokenClaims } = require('./middleware/authMiddleware');
const { assertJwtSecret } = require('./utils/security');

// Load env vars
dotenv.config();

assertJwtSecret(process.env.JWT_SECRET);

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  const missingEnvVars = ['MONGODB_URI'].filter((key) => !process.env[key]);
  if (missingEnvVars.length) {
    throw new Error(`Missing required production environment variables: ${missingEnvVars.join(', ')}`);
  }
}

const frontendBuildPath = path.join(__dirname, '../frontend/build');
const frontendIndexPath = path.join(frontendBuildPath, 'index.html');

if (isProduction && !fs.existsSync(frontendIndexPath)) {
  throw new Error('Frontend build is missing. Build frontend before starting the production server.');
}

const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  ...(process.env.CLIENT_URL || '').split(','),
  ...(process.env.CLIENT_URLS || '').split(','),
].map((origin) => origin.trim()).filter(Boolean);

const corsOrigin = (origin, callback) => {
  callback(null, !origin || allowedOrigins.includes(origin));
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const server = http.createServer(app);

const io = new Server(server, {
  transports: ['websocket'],
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  },
});

global.io = io;

io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (typeof token !== 'string' || !token) {
    return next(new Error('Authentication required.'));
  }

  const { claims, error } = verifyTokenClaims(token);
  if (error) return next(new Error('Invalid authentication token.'));

  try {
    const user = await User.findById(claims.id).select('-password');
    if (!user) return next(new Error('Authenticated user not found.'));
    // Reject sockets authenticated with a token issued before a password change.
    if (user.isTokenStale(claims.iat)) return next(new Error('Invalid authentication token.'));

    socket.data.userId = user._id.toString();
    next();
  } catch (lookupError) {
    next(new Error('Invalid authentication token.'));
  }
});

// The React build uses inline styles, and Razorpay Checkout is an external
// script/frame, so those are the only relaxations in the policy.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com")');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
// Express CORS
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.post('/api/payments/razorpay/webhook', express.raw({ type: 'application/json', limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Socket connections
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', () => {
    socket.join(socket.data.userId);
    console.log(`User ${socket.data.userId} joined their personal room`);
  });

  socket.on('join_conversation', async (conversationId) => {
    if (!isValidObjectId(conversationId)) return;
    try {
      const conversation = await Conversation.findById(conversationId).select('participants');
      const isParticipant = conversation
        && conversation.participants.some(
          (participant) => participant.toString() === socket.data.userId,
        );
      if (!isParticipant) return;

      socket.join(conversationId);
      console.log(`User ${socket.data.userId} joined conversation ${conversationId}`);
    } catch (error) {
      console.error('Could not authorize conversation socket room:', error);
    }
  });

  socket.on('typing', (data) => {
    if (!data || typeof data.conversationId !== 'string' || !socket.rooms.has(data.conversationId)) {
      return;
    }
    socket.to(data.conversationId).emit('user_typing', {
      conversationId: data.conversationId,
      userId: socket.data.userId,
      typing: Boolean(data.typing),
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Database connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/flex', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000,
})
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error(
    'MongoDB connection failed. Check MONGODB_URI, the database user/password (URL-encode special characters), and Atlas Network Access (allow 0.0.0.0/0).',
    err,
  ));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/proposals', require('./routes/proposals'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/ai', require('./routes/ai'));

app.get('/health', (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.json({ status: 'ok', database: connected ? 'connected' : 'disconnected' });
});

app.get('/health/db', (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'unavailable',
    database: connected ? 'connected' : 'disconnected',
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ message: 'API route not found' });
});

if (fs.existsSync(frontendIndexPath)) {
  app.use('/static', express.static(path.join(frontendBuildPath, 'static'), {
    maxAge: '1y',
    immutable: true,
    fallthrough: false,
  }));
  app.use(express.static(frontendBuildPath, { index: false }));
  app.get('*', (req, res, next) => {
    if (
      !['GET', 'HEAD'].includes(req.method)
      || path.extname(req.path)
      || !(req.get('accept') || '').toLowerCase().includes('text/html')
    ) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(frontendIndexPath, { cacheControl: false }, (error) => {
      if (error) next(error);
    });
  });
} else {
  app.get('/', (req, res) => {
    res.send('Backend is running');
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  const message = status >= 500 && isProduction
    ? 'Internal server error'
    : err.message || 'Something went wrong on the server';
  res.status(status).json({ message });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
