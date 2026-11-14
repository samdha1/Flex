const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { Server } = require('socket.io');

// Load env vars
dotenv.config();

if (process.env.NODE_ENV === 'production') {
  const missingEnvVars = ['MONGODB_URI', 'JWT_SECRET'].filter((key) => !process.env[key]);
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

  socket.on('join', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined their personal room`);
  });

  socket.on('join_conversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`User joined conversation ${conversationId}`);
  });

  socket.on('typing', (data) => {
    // data: { conversationId, userId, typing }
    socket.to(data.conversationId).emit('user_typing', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Database connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/flex', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

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
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: 'unavailable', database: 'disconnected' });
  }
  res.json({ status: 'ok' });
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
