const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Conversation = require('./models/Conversation');

// Load env vars
dotenv.config();

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in all environments before starting the server.');
}

if (process.env.NODE_ENV === 'production') {
  const missingEnvVars = ['MONGODB_URI'].filter((key) => !process.env[key]);
  if (missingEnvVars.length) {
    throw new Error(`Missing required production environment variables: ${missingEnvVars.join(', ')}`);
  }
}

const frontendBuildPath = path.join(__dirname, '../frontend/build');
const frontendIndexPath = path.join(frontendBuildPath, 'index.html');

if (process.env.NODE_ENV === 'production' && !fs.existsSync(frontendIndexPath)) {
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

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (typeof decoded !== 'object' || !decoded.id) {
      return next(new Error('Invalid authentication token.'));
    }

    const user = await User.findById(decoded.id).select('_id');
    if (!user) return next(new Error('Authenticated user not found.'));
    socket.data.userId = user._id.toString();
    next();
  } catch (error) {
    next(new Error('Invalid authentication token.'));
  }
});

// Middleware
// Express CORS
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Socket connections
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', () => {
    socket.join(socket.data.userId);
    console.log(`User ${socket.data.userId} joined their personal room`);
  });

  socket.on('join_conversation', async (conversationId) => {
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

if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(frontendIndexPath, (error) => {
      if (error) next(error);
    });
  });
} else {
  app.get('/', (req, res) => {
    res.send('Backend is running');
  });
}

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: err.message || 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
