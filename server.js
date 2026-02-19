require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// Ensure required directories exist
for (const dir of [DATA_DIR, SESSIONS_DIR, 'uploads', 'output']) {
  const fullPath = dir.includes(path.sep) ? dir : path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
}

// Initialize database (creates tables via migrations)
async function start() {
  const db = await require('./src/db/database').init();

  // Middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Sessions — file-backed, 30-day expiry
  app.use(session({
    store: new FileStore({
      path: SESSIONS_DIR,
      ttl: 30 * 24 * 60 * 60, // 30 days in seconds
      retries: 0,
      logFn: () => {}          // suppress noisy logs
    }),
    secret: process.env.SESSION_SECRET || 'still-beside-me-dev-secret',
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      sameSite: 'lax'
    }
  }));

  // Make db available to routes
  app.locals.db = db;

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // Clean URL: /customize → customize.html
  app.get('/customize', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customize.html'));
  });

  // API routes
  app.use('/api', require('./src/routes/api'));
  app.use('/api/templates', require('./src/routes/templates'));

  app.listen(PORT, () => {
    console.log(`\n  Still Beside Me — Memorial Art Store`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  http://localhost:${PORT}/customize\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
