const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const multer = require('multer');
require('dotenv').config();
const { sendOTPEmail, sendPasswordChangedEmail } = require('./emailService');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'soundlounge.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const JWT_SECRET = process.env.JWT_SECRET || 'soundlounge-dev-secret-change-me';
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 10);
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 5);
const LOCKOUT_DURATION_MINUTES = Number(process.env.LOCKOUT_DURATION_MINUTES || 15);
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_USER_EMAIL = 'alex.vance@soundlounge.io';
const DEFAULT_USER_PASSWORD = 'demo1234';

async function deliverOTPOrThrow(email, code, purpose) {
  const result = await sendOTPEmail(email, code, purpose);
  if (!result.success) {
    throw new Error(result.error || 'Email provider rejected the OTP.');
  }
  return result;
}

function buildTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      subscription_tier TEXT DEFAULT 'premium',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      owner_id TEXT,
      bio TEXT,
      avatar_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      owner_id TEXT,
      genre TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      audio_url TEXT NOT NULL,
      cover_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      play_count INTEGER DEFAULT 0,
      is_public INTEGER DEFAULT 1,
      deleted_at TEXT,
      FOREIGN KEY (artist_id) REFERENCES artists(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
    CREATE INDEX IF NOT EXISTS idx_tracks_public ON tracks(is_public);

    CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, track_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (track_id) REFERENCES tracks(id)
    );

    CREATE TABLE IF NOT EXISTS listening_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_played_seconds INTEGER,
      completion_percentage REAL DEFAULT 0,
      source TEXT DEFAULT 'queue',
      session_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (track_id) REFERENCES tracks(id)
    );

    CREATE TABLE IF NOT EXISTS hidden_tracks (
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, track_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (track_id) REFERENCES tracks(id)
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cover_url TEXT,
      is_public INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (playlist_id, track_id),
      UNIQUE (playlist_id, position),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id),
      FOREIGN KEY (track_id) REFERENCES tracks(id)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      volume INTEGER DEFAULT 80,
      shuffle_enabled INTEGER DEFAULT 0,
      repeat_mode TEXT DEFAULT 'off',
      dark_mode INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS playback_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      playback_position_seconds INTEGER DEFAULT 0,
      session_id TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (track_id) REFERENCES tracks(id)
    );
    CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);
    CREATE INDEX IF NOT EXISTS idx_otp_purpose ON otp_codes(purpose);

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS login_audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      email TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      success INTEGER NOT NULL,
      failure_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_audit_user ON login_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_email ON login_audit_log(email);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON login_audit_log(created_at DESC);
  `);

  // Add ownership to databases created before uploads were introduced.
  const artistColumns = db.pragma('table_info(artists)').map((column) => column.name);
  if (!artistColumns.includes('owner_id')) db.exec('ALTER TABLE artists ADD COLUMN owner_id TEXT');
  const trackColumns = db.pragma('table_info(tracks)').map((column) => column.name);
  if (!trackColumns.includes('owner_id')) db.exec('ALTER TABLE tracks ADD COLUMN owner_id TEXT');
  if (!trackColumns.includes('deleted_at')) db.exec('ALTER TABLE tracks ADD COLUMN deleted_at TEXT');

  // Add auth columns to users table if missing
  const userColumns = db.pragma('table_info(users)').map((column) => column.name);
  if (!userColumns.includes('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0');
    // Grandfather existing users as verified
    db.exec('UPDATE users SET email_verified = 1 WHERE email_verified IS NULL OR email_verified = 0');
  }
  if (!userColumns.includes('failed_login_attempts')) {
    db.exec('ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0');
  }
  if (!userColumns.includes('locked_until')) {
    db.exec('ALTER TABLE users ADD COLUMN locked_until TEXT');
  }
}

function generateId() {
  return crypto.randomUUID();
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, display_name: user.display_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ── OTP & Security Helpers ───────────────────────────────────────────────────

function generateOTP() {
  return String(crypto.randomInt(100000, 999999));
}

function createOTP(userId, email, purpose) {
  // Invalidate any existing unused OTPs for same email+purpose
  db.prepare('UPDATE otp_codes SET used = 1 WHERE email = ? AND purpose = ? AND used = 0')
    .run(email, purpose);

  const code = generateOTP();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();
  db.prepare('INSERT INTO otp_codes (id, user_id, email, code, purpose, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(generateId(), userId, email, code, purpose, expiresAt);
  return code;
}

function validateOTP(email, code, purpose) {
  const otp = db.prepare(`
    SELECT * FROM otp_codes
    WHERE email = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(email, code, purpose, new Date().toISOString());

  if (!otp) return null;

  // Mark as used
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otp.id);
  return otp;
}

function canResendOTP(email, purpose) {
  const lastOTP = db.prepare(`
    SELECT created_at FROM otp_codes
    WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1
  `).get(email, purpose);

  if (!lastOTP) return { allowed: true };

  const elapsed = (Date.now() - new Date(lastOTP.created_at).getTime()) / 1000;
  if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) {
    return { allowed: false, retryAfter: Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed) };
  }
  return { allowed: true };
}

function logLoginAttempt(userId, email, ip, userAgent, success, failureReason = null) {
  db.prepare(`
    INSERT INTO login_audit_log (id, user_id, email, ip_address, user_agent, success, failure_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(generateId(), userId, email, ip, userAgent, success ? 1 : 0, failureReason);
}

function isAccountLocked(user) {
  if (!user.locked_until) return false;
  return new Date(user.locked_until) > new Date();
}

function lockAccount(userId) {
  const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET locked_until = ?, failed_login_attempts = ? WHERE id = ?')
    .run(lockedUntil, MAX_LOGIN_ATTEMPTS, userId);
  return lockedUntil;
}

function resetLoginAttempts(userId) {
  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
}

function incrementLoginAttempts(userId) {
  db.prepare('UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?').run(userId);
  const user = db.prepare('SELECT failed_login_attempts FROM users WHERE id = ?').get(userId);
  if (user && user.failed_login_attempts >= MAX_LOGIN_ATTEMPTS) {
    return lockAccount(userId);
  }
  return null;
}

function validatePasswordStrength(password) {
  const errors = [];
  if (password.length < 8) errors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('one uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('one lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('one number');
  return errors;
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, email, display_name, avatar_url, subscription_tier, created_at FROM users WHERE id = ?').get(decoded.sub);
    if (!user) {
      return res.status(401).json({ error: 'Invalid user session.' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function optionalAuthMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = db.prepare('SELECT id, email, display_name, avatar_url, subscription_tier, created_at FROM users WHERE id = ?').get(decoded.sub) || null;
  } catch (error) {
    req.user = null;
  }
  next();
}

function serializeTrack(track, userId = null) {
  const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(track.artist_id);
  const liked = userId ? !!db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?').get(userId, track.id) : false;
  return {
    id: track.id,
    title: track.title,
    artist: artist ? artist.name : 'Unknown Artist',
    artist_id: track.artist_id,
    genre: track.genre,
    duration: track.duration_seconds,
    duration_seconds: track.duration_seconds,
    audio_url: track.audio_url,
    cover_url: track.cover_url,
    cover: track.cover_url,
    liked,
    is_public: Boolean(track.is_public),
    play_count: track.play_count || 0,
    created_at: track.created_at
  };
}

function getUserPreferences(userId) {
  return db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) || {
    user_id: userId,
    volume: 80,
    shuffle_enabled: 0,
    repeat_mode: 'off',
    dark_mode: 1,
    updated_at: new Date().toISOString()
  };
}

function ensureDefaultUser() {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(DEFAULT_USER_EMAIL);
  if (existing) {
    if (existing.subscription_tier !== 'free') {
      db.prepare('UPDATE users SET subscription_tier = ? WHERE id = ?').run('free', existing.id);
      existing.subscription_tier = 'free';
    }
    if (Object.prototype.hasOwnProperty.call(existing, 'email_verified') && !existing.email_verified) {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(existing.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
    }
    return existing;
  }

  const userId = generateId();
  const passwordHash = hashPassword(DEFAULT_USER_PASSWORD);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name, avatar_url, subscription_tier, email_verified)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(userId, DEFAULT_USER_EMAIL, passwordHash, 'Alex Vance', 'https://images.unsplash.com/...', 'premium');

  db.prepare('INSERT INTO user_preferences (user_id, volume, shuffle_enabled, repeat_mode, dark_mode) VALUES (?, ?, ?, ?, ?)')
    .run(userId, 80, 0, 'off', 1);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function seedArtistsAndTracks() {
  const artists = [
    { id: generateId(), name: 'Lo-Fi Feline', bio: 'Sleepy synth loops for late-night focus.', avatar_url: 'https://images.unsplash.com/...'},
    { id: generateId(), name: 'Chill Whiskers', bio: 'Warm acoustic textures and dreamy lounge grooves.', avatar_url: 'https://images.unsplash.com/...'},
    { id: generateId(), name: 'Tabby Beats', bio: 'Soft jazz-inspired rhythms with a playful edge.', avatar_url: 'https://images.unsplash.com/...'},
    { id: generateId(), name: 'Velvet Paws', bio: 'Ambient, atmospheric warmth for every corner of the day.', avatar_url: 'https://images.unsplash.com/...'},
    { id: generateId(), name: 'Jazz Cat', bio: 'Smooth improvisation with cinematic detail.', avatar_url: 'https://images.unsplash.com/...'},
    { id: generateId(), name: 'Synth Purr', bio: 'Midnight synth textures for movement and momentum.', avatar_url: 'https://images.unsplash.com/...'},
    { id: generateId(), name: 'Cyber Kitten', bio: 'Neon pulses and futuristic rhythmic escapes.', avatar_url: 'https://images.unsplash.com/...'},
    { id: generateId(), name: 'Acoustic Paws', bio: 'Coffee-shop softness with gentle storytelling.', avatar_url: 'https://images.unsplash.com/...'}
  ];

  for (const artist of artists) {
    const check = db.prepare('SELECT id FROM artists WHERE name = ?').get(artist.name);
    if (!check) {
      db.prepare('INSERT INTO artists (id, name, bio, avatar_url) VALUES (?, ?, ?, ?)').run(artist.id, artist.name, artist.bio, artist.avatar_url);
    }
  }

  const artistMap = Object.fromEntries(db.prepare('SELECT id, name FROM artists').all().map((row) => [row.name, row.id]));
  const seeds = [
    ['Midnight Purr', 'Lo-Fi Feline', 'Lo-Fi', 372, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80'],
    ['Cozy Naps', 'Chill Whiskers', 'Chill', 274, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80'],
    ['Sunbeam Groove', 'Tabby Beats', 'Jazz', 218, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=900&q=80'],
    ['Rainy Window', 'Velvet Paws', 'Lo-Fi', 340, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=900&q=80'],
    ['Moonlight Prowl', 'Jazz Cat', 'Jazz', 291, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3', 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=900&q=80'],
    ['Morning Stretch', 'Synth Purr', 'Synth', 245, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=900&q=80'],
    ['Neon Alley Run', 'Cyber Kitten', 'Synth', 266, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3', 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=900&q=80'],
    ['Coffee Shop Whispers', 'Acoustic Paws', 'Chill', 304, 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=900&q=80']
  ];

  for (const [title, artistName, genre, durationSeconds, audioUrl, coverUrl] of seeds) {
    const existing = db.prepare('SELECT id FROM tracks WHERE title = ?').get(title);
    if (!existing) {
      db.prepare(`
        INSERT INTO tracks (id, title, artist_id, genre, duration_seconds, audio_url, cover_url, play_count, is_public)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(generateId(), title, artistMap[artistName], genre, durationSeconds, audioUrl, coverUrl, Math.floor(Math.random() * 2000) + 400);
    }
  }
}

function ensureSeedData() {
  buildTables();
  const user = ensureDefaultUser();
  seedArtistsAndTracks();

  const tracks = db.prepare('SELECT * FROM tracks').all();
  const likedTrackIds = tracks.slice(0, 4).map((track) => track.id);
  for (const trackId of likedTrackIds) {
    const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?').get(user.id, trackId);
    if (!existing) {
      db.prepare('INSERT INTO likes (user_id, track_id) VALUES (?, ?)').run(user.id, trackId);
    }
  }

  const recentTrackId = tracks[0]?.id;
  if (recentTrackId) {
    const historyExists = db.prepare('SELECT 1 FROM listening_history WHERE user_id = ? AND track_id = ?').get(user.id, recentTrackId);
    if (!historyExists) {
      db.prepare('INSERT INTO listening_history (id, user_id, track_id, started_at, ended_at, duration_played_seconds, completion_percentage, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(generateId(), user.id, recentTrackId, new Date(Date.now() - 7200000).toISOString(), new Date(Date.now() - 7000000).toISOString(), 190, 72, 'recommendation');
    }
  }
}

ensureSeedData();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

const audioExtensions = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const audioMimeTypes = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac'
]);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const uploadStorage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${crypto.randomUUID()}${extension}`);
  }
});
const uploadFiles = multer({
  storage: uploadStorage,
  limits: { files: 2, fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isAudio = file.fieldname === 'audio';
    const valid = isAudio
      ? audioExtensions.has(extension) && audioMimeTypes.has(file.mimetype.toLowerCase())
      : file.fieldname === 'cover' && imageExtensions.has(extension) && imageMimeTypes.has(file.mimetype.toLowerCase());
    callback(valid ? null : new Error(`Invalid ${isAudio ? 'audio' : 'cover image'} file type.`), valid);
  }
}).fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'iksa-player-backend', timestamp: new Date().toISOString() });
});

app.get('/api/auth/check-email', (req, res) => {
  const normalizedEmail = String(req.query.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const existing = db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalizedEmail);
  return res.json({ available: !existing, exists: Boolean(existing) });
});

// ── Registration with OTP verification ────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedName = String(displayName || '').trim();
  if (!normalizedEmail || !password || !normalizedName) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const pwErrors = validatePasswordStrength(String(password));
  if (pwErrors.length) {
    return res.status(400).json({ error: `Password needs: ${pwErrors.join(', ')}.` });
  }

  const existing = db.prepare('SELECT id, email_verified FROM users WHERE email = ?').get(normalizedEmail);

  // If account exists but unverified, allow re-sending OTP
  if (existing && !existing.email_verified) {
    const cooldown = canResendOTP(normalizedEmail, 'email_verify');
    if (!cooldown.allowed) {
      return res.status(429).json({ error: `Please wait ${cooldown.retryAfter}s before requesting a new code.` });
    }
    const code = createOTP(existing.id, normalizedEmail, 'email_verify');
    try {
      await deliverOTPOrThrow(normalizedEmail, code, 'email_verify');
    } catch (error) {
      return res.status(503).json({ error: `Unable to send verification email: ${error.message}` });
    }
    return res.status(200).json({
      requiresVerification: true,
      email: normalizedEmail,
      message: 'Verification code resent to your email.'
    });
  }

  if (existing) {
    return res.status(409).json({ error: 'Account already exists. Please log in.' });
  }

  const userId = generateId();
  const user = {
    id: userId,
    email: normalizedEmail,
    password_hash: hashPassword(String(password)),
    display_name: normalizedName,
    avatar_url: null,
    subscription_tier: 'free'
  };

  db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name, avatar_url, subscription_tier, email_verified)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(user.id, user.email, user.password_hash, user.display_name, user.avatar_url, user.subscription_tier);

  db.prepare('INSERT INTO user_preferences (user_id, volume, shuffle_enabled, repeat_mode, dark_mode) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, 80, 0, 'off', 1);

  // Generate and send OTP
  const code = createOTP(userId, normalizedEmail, 'email_verify');
  try {
    await deliverOTPOrThrow(normalizedEmail, code, 'email_verify');
  } catch (error) {
    return res.status(503).json({ error: `Unable to send verification email: ${error.message}` });
  }

  return res.status(201).json({
    requiresVerification: true,
    email: normalizedEmail,
    message: 'Account created! Check your email for a verification code.'
  });
});

// ── Verify OTP (email verification after signup) ──────────────────────────────
app.post('/api/auth/verify-otp', (req, res) => {
  const { email, code } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !code) {
    return res.status(400).json({ error: 'Email and verification code are required.' });
  }

  const otp = validateOTP(normalizedEmail, String(code).trim(), 'email_verify');
  if (!otp) {
    return res.status(400).json({ error: 'Invalid or expired verification code.' });
  }

  // Mark user as verified
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(otp.user_id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(otp.user_id);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const sanitized = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    subscription_tier: user.subscription_tier,
    created_at: user.created_at
  };

  return res.json({
    user: sanitized,
    token: issueToken(user),
    message: 'Email verified successfully!'
  });
});

// ── Resend OTP ────────────────────────────────────────────────────────────────
app.post('/api/auth/resend-otp', async (req, res) => {
  const { email, purpose = 'email_verify' } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const user = db.prepare('SELECT id, email_verified FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) {
    // Don't reveal whether account exists
    return res.json({ message: 'If an account exists, a new code has been sent.' });
  }

  if (purpose === 'email_verify' && user.email_verified) {
    return res.status(400).json({ error: 'Email is already verified.' });
  }

  const cooldown = canResendOTP(normalizedEmail, purpose);
  if (!cooldown.allowed) {
    return res.status(429).json({
      error: `Please wait ${cooldown.retryAfter} seconds before requesting a new code.`,
      retryAfter: cooldown.retryAfter
    });
  }

  const code = createOTP(user.id, normalizedEmail, purpose);
  try {
    await deliverOTPOrThrow(normalizedEmail, code, purpose);
  } catch (error) {
    return res.status(503).json({ error: `Unable to send OTP email: ${error.message}` });
  }

  return res.json({ message: 'If an account exists, a new code has been sent.' });
});

// ── Login with lockout + audit ────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  if (!normalizedEmail || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

  if (!user) {
    logLoginAttempt(null, normalizedEmail, clientIP, userAgent, false, 'user_not_found');
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // Check account lockout
  if (isAccountLocked(user)) {
    const remaining = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    logLoginAttempt(user.id, normalizedEmail, clientIP, userAgent, false, 'account_locked');
    return res.status(423).json({
      error: `Account is temporarily locked. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`,
      lockedUntil: user.locked_until,
      remainingMinutes: remaining
    });
  }

  // Check email verification
  if (!user.email_verified) {
    logLoginAttempt(user.id, normalizedEmail, clientIP, userAgent, false, 'email_not_verified');
    return res.status(403).json({
      error: 'Please verify your email before logging in.',
      requiresVerification: true,
      email: normalizedEmail
    });
  }

  // Validate password
  const valid = bcrypt.compareSync(String(password), user.password_hash);
  if (!valid) {
    const lockedUntil = incrementLoginAttempts(user.id);
    logLoginAttempt(user.id, normalizedEmail, clientIP, userAgent, false, 'wrong_password');
    const attempts = (user.failed_login_attempts || 0) + 1;
    const remaining = MAX_LOGIN_ATTEMPTS - attempts;

    if (lockedUntil) {
      return res.status(423).json({
        error: `Too many failed attempts. Account locked for ${LOCKOUT_DURATION_MINUTES} minutes.`,
        lockedUntil,
        remainingMinutes: LOCKOUT_DURATION_MINUTES
      });
    }

    return res.status(401).json({
      error: `Invalid email or password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
    });
  }

  // Success — reset attempts and log
  resetLoginAttempts(user.id);
  logLoginAttempt(user.id, normalizedEmail, clientIP, userAgent, true);

  const sanitized = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    subscription_tier: user.subscription_tier,
    created_at: user.created_at
  };

  return res.json({
    user: sanitized,
    token: issueToken(user)
  });
});

// ── Forgot Password (send OTP) ────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  // Always respond with same message (don't reveal if account exists)
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (user) {
    const cooldown = canResendOTP(normalizedEmail, 'password_reset');
    if (!cooldown.allowed) {
      return res.status(429).json({
        error: `Please wait ${cooldown.retryAfter} seconds before requesting another code.`,
        retryAfter: cooldown.retryAfter
      });
    }
    const code = createOTP(user.id, normalizedEmail, 'password_reset');
    try {
      await deliverOTPOrThrow(normalizedEmail, code, 'password_reset');
    } catch (error) {
      return res.status(503).json({ error: `Unable to send password reset email: ${error.message}` });
    }
  }

  return res.json({ message: 'If an account exists with that email, a reset code has been sent.' });
});

// ── Verify Reset OTP (returns one-time reset token) ───────────────────────────
app.post('/api/auth/verify-reset-otp', (req, res) => {
  const { email, code } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !code) {
    return res.status(400).json({ error: 'Email and reset code are required.' });
  }

  const otp = validateOTP(normalizedEmail, String(code).trim(), 'password_reset');
  if (!otp) {
    return res.status(400).json({ error: 'Invalid or expired reset code.' });
  }

  // Generate a one-time reset token valid for 15 minutes
  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
    .run(generateId(), otp.user_id, resetToken, expiresAt);

  return res.json({ resetToken, message: 'Code verified. You can now set a new password.' });
});

// ── Reset Password (with token from verify-reset-otp) ─────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { resetToken, newPassword } = req.body || {};
  if (!resetToken || !newPassword) {
    return res.status(400).json({ error: 'Reset token and new password are required.' });
  }

  const pwErrors = validatePasswordStrength(String(newPassword));
  if (pwErrors.length) {
    return res.status(400).json({ error: `Password needs: ${pwErrors.join(', ')}.` });
  }

  const tokenRow = db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE token = ? AND used = 0 AND expires_at > ?
  `).get(resetToken, new Date().toISOString());

  if (!tokenRow) {
    return res.status(400).json({ error: 'Invalid or expired reset token. Please start over.' });
  }

  // Update password and mark token as used
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(hashPassword(String(newPassword)), tokenRow.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(tokenRow.id);

  // Reset any lockout
  resetLoginAttempts(tokenRow.user_id);

  // Send notification email
  const user = db.prepare('SELECT email, display_name FROM users WHERE id = ?').get(tokenRow.user_id);
  if (user) {
    await sendPasswordChangedEmail(user.email, user.display_name);
  }

  return res.json({ message: 'Password has been reset successfully. You can now log in.' });
});

// ── Change Password (authenticated) ──────────────────────────────────────────
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const valid = bcrypt.compareSync(String(currentPassword), user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const pwErrors = validatePasswordStrength(String(newPassword));
  if (pwErrors.length) {
    return res.status(400).json({ error: `New password needs: ${pwErrors.join(', ')}.` });
  }

  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(hashPassword(String(newPassword)), user.id);

  await sendPasswordChangedEmail(user.email, user.display_name);

  return res.json({ message: 'Password changed successfully.' });
});

// ── Login Sessions / Audit Log ───────────────────────────────────────────────
app.get('/api/auth/sessions', authMiddleware, (req, res) => {
  const logs = db.prepare(`
    SELECT id, ip_address, user_agent, success, failure_reason, created_at
    FROM login_audit_log
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(req.user.id);
  return res.json({ sessions: logs });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const { password_hash, ...safeUser } = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: safeUser, preferences: getUserPreferences(req.user.id) });
});

app.post('/api/uploads/tracks', authMiddleware, (req, res, next) => {
  uploadFiles(req, res, (uploadError) => {
    if (uploadError) return next(uploadError);

    const audio = req.files?.audio?.[0];
    const cover = req.files?.cover?.[0];
    const removeFiles = () => [audio, cover].filter(Boolean).forEach((file) => {
      try { fs.unlinkSync(file.path); } catch (error) { /* best effort cleanup */ }
    });
    const title = String(req.body?.title || '').trim();
    const genre = String(req.body?.genre || '').trim();
    const artistName = String(req.body?.artist || req.body?.artistName || '').trim();

    if (!audio) {
      removeFiles();
      return res.status(400).json({ error: 'An audio file is required.' });
    }
    if (!title || title.length > 255) {
      removeFiles();
      return res.status(400).json({ error: 'Title is required and must be 255 characters or fewer.' });
    }
    if (!genre || genre.length > 100) {
      removeFiles();
      return res.status(400).json({ error: 'Genre is required and must be 100 characters or fewer.' });
    }
    if (!artistName || artistName.length > 255) {
      removeFiles();
      return res.status(400).json({ error: 'Artist name is required and must be 255 characters or fewer.' });
    }
    if (cover && cover.size > 10 * 1024 * 1024) {
      removeFiles();
      return res.status(400).json({ error: 'Cover image must be 10 MB or smaller.' });
    }

    const duration = Number(req.body?.durationSeconds);
    const durationSeconds = Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0;
    const isPublic = String(req.body?.isPublic ?? 'true').toLowerCase() !== 'false';
    try {
      let artist = db.prepare('SELECT * FROM artists WHERE name = ?').get(artistName);
      if (!artist) {
        artist = { id: generateId(), name: artistName };
        db.prepare('INSERT INTO artists (id, name, owner_id) VALUES (?, ?, ?)').run(artist.id, artist.name, req.user.id);
      }
      const track = {
        id: generateId(),
        title,
        artist_id: artist.id,
        genre,
        duration_seconds: durationSeconds,
        audio_url: `/uploads/${audio.filename}`,
        cover_url: cover ? `/uploads/${cover.filename}` : null,
        owner_id: req.user.id
      };
      db.prepare(`
        INSERT INTO tracks (id, title, artist_id, genre, duration_seconds, audio_url, cover_url, owner_id, is_public)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(track.id, track.title, track.artist_id, track.genre, track.duration_seconds, track.audio_url, track.cover_url, track.owner_id, isPublic ? 1 : 0);
      return res.status(201).json({ track: serializeTrack({ ...track, is_public: isPublic ? 1 : 0, play_count: 0 }) });
    } catch (error) {
      removeFiles();
      return next(error);
    }
  });
});

app.get('/api/uploads/mine', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT tracks.*
    FROM tracks
    WHERE tracks.owner_id = ? AND tracks.deleted_at IS NULL
    ORDER BY tracks.created_at DESC
  `).all(req.user.id);
  res.json({ tracks: rows.map((track) => serializeTrack(track, req.user.id)) });
});

app.delete('/api/uploads/batch-delete', authMiddleware, (req, res, next) => {
  const ids = Array.isArray(req.body?.trackIds) ? [...new Set(req.body.trackIds.map(String))].filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'At least one track is required.' });
  try {
    const deletedAt = new Date().toISOString();
    const update = db.prepare('UPDATE tracks SET deleted_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL');
    const deleteTracks = db.transaction(() => ids.reduce((count, id) => count + update.run(deletedAt, id, req.user.id).changes, 0));
    const deletedCount = deleteTracks();
    return res.json({ deleted: true, deletedCount, trackIds: ids });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/uploads/restore', authMiddleware, (req, res, next) => {
  const ids = Array.isArray(req.body?.trackIds) ? [...new Set(req.body.trackIds.map(String))].filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'At least one track is required.' });
  try {
    const restore = db.prepare('UPDATE tracks SET deleted_at = NULL WHERE id = ? AND owner_id = ?');
    const restoreTracks = db.transaction(() => ids.reduce((count, id) => count + restore.run(id, req.user.id).changes, 0));
    return res.json({ restored: true, restoredCount: restoreTracks(), trackIds: ids });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/uploads/:trackId', authMiddleware, (req, res, next) => {
  const track = db.prepare(`
    SELECT tracks.*, artists.name AS artist_name
    FROM tracks
    INNER JOIN artists ON artists.id = tracks.artist_id
    WHERE tracks.id = ? AND tracks.owner_id = ? AND tracks.deleted_at IS NULL
  `).get(req.params.trackId, req.user.id);

  if (!track) return res.status(404).json({ error: 'Owned upload not found.' });

  const removeStoredFile = (fileUrl) => {
    if (!fileUrl || !fileUrl.startsWith('/uploads/')) return;
    const filePath = path.join(uploadsDir, path.basename(fileUrl));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  };

  try {
    db.transaction(() => {
      db.prepare('DELETE FROM likes WHERE track_id = ?').run(track.id);
      db.prepare('DELETE FROM listening_history WHERE track_id = ?').run(track.id);
      db.prepare('DELETE FROM hidden_tracks WHERE track_id = ?').run(track.id);
      db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(track.id);
      const result = db.prepare('DELETE FROM tracks WHERE id = ? AND owner_id = ?').run(track.id, req.user.id);
      if (result.changes !== 1) throw new Error('Track deletion did not complete.');
      removeStoredFile(track.audio_url);
      removeStoredFile(track.cover_url);
    })();
    return res.json({ deleted: true, trackId: track.id });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/uploads/:trackId/download', authMiddleware, (req, res) => {
  const track = db.prepare(`
    SELECT tracks.*, artists.name AS artist_name
    FROM tracks
    INNER JOIN artists ON artists.id = tracks.artist_id
    WHERE tracks.id = ? AND tracks.owner_id = ? AND tracks.deleted_at IS NULL
  `).get(req.params.trackId, req.user.id);

  if (!track || !track.audio_url.startsWith('/uploads/')) {
    return res.status(404).json({ error: 'Owned upload not found.' });
  }

  const filename = path.basename(track.audio_url);
  const safeTitle = `${track.title} - ${track.artist_name}`
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'iksa-player-track';
  const extension = path.extname(filename) || '.mp3';

  return res.download(path.join(uploadsDir, filename), `${safeTitle}${extension}`, (error) => {
    if (error && !res.headersSent) {
      res.status(error.statusCode || 404).json({ error: 'Uploaded audio file is unavailable.' });
    }
  });
});

app.get('/api/tracks/:trackId/download', authMiddleware, async (req, res) => {
  const track = db.prepare(`
    SELECT tracks.*, artists.name AS artist_name
    FROM tracks
    INNER JOIN artists ON artists.id = tracks.artist_id
    WHERE tracks.id = ? AND tracks.is_public = 1 AND tracks.deleted_at IS NULL
  `).get(req.params.trackId);

  if (!track) {
    return res.status(404).json({ error: 'Public track not found.' });
  }

  const safeTitle = `${track.title} - ${track.artist_name}`
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'iksa-player-track';
  const extension = path.extname(track.audio_url) || '.mp3';

  if (track.audio_url.startsWith('/uploads/')) {
    return res.download(
      path.join(uploadsDir, path.basename(track.audio_url)),
      `${safeTitle}${extension}`,
      (error) => {
        if (error && !res.headersSent) {
          res.status(error.statusCode || 404).json({ error: 'Track file is unavailable.' });
        }
      }
    );
  }

  try {
    const upstream = await fetch(track.audio_url);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Track download source is unavailable.' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}${extension}"`);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error('Track download error:', error);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Unable to download track.' });
    } else {
      res.end();
    }
  }
});

app.get('/api/tracks', optionalAuthMiddleware, (req, res) => {
  const { genre, q, artist, tab = 'all', sort = 'popular', limit = 50 } = req.query;
  const userId = req.user ? req.user.id : null;
  let sql = `SELECT * FROM tracks WHERE is_public = 1 AND deleted_at IS NULL`;
  const params = [];

  if (userId) {
    sql += ` AND NOT EXISTS (SELECT 1 FROM hidden_tracks WHERE user_id = ? AND track_id = tracks.id)`;
    params.push(userId);
  }

  if (genre && genre !== 'all') {
    sql += ' AND genre = ?';
    params.push(String(genre));
  }

  if (artist) {
    sql += ' AND tracks.artist_id = ?';
    params.push(String(artist));
  }

  if (q) {
    sql += ' AND (LOWER(title) LIKE ? OR LOWER((SELECT name FROM artists WHERE id = tracks.artist_id)) LIKE ? OR LOWER(genre) LIKE ?)';
    const needle = `%${String(q).toLowerCase()}%`;
    params.push(needle, needle, needle);
  }

  if (tab === 'liked' && userId) {
    sql = `SELECT tracks.* FROM tracks INNER JOIN likes ON likes.track_id = tracks.id WHERE likes.user_id = ? AND tracks.is_public = 1 AND tracks.deleted_at IS NULL`;
    params.length = 0;
    params.push(userId);
  }

  if (tab === 'recent' && userId) {
    sql = `SELECT DISTINCT tracks.* FROM tracks INNER JOIN listening_history ON listening_history.track_id = tracks.id WHERE listening_history.user_id = ? AND tracks.is_public = 1 AND tracks.deleted_at IS NULL`;
    params.length = 0;
    params.push(userId);
  }

  const sortSql = {
    name: 'title COLLATE NOCASE ASC',
    artist: '(SELECT name FROM artists WHERE id = tracks.artist_id) COLLATE NOCASE ASC',
    newest: 'created_at DESC',
    recent: 'created_at DESC',
    most_played: 'play_count DESC',
    popular: 'play_count DESC'
  }[String(sort)] || 'play_count DESC';
  const orderSql = tab === 'recent' && userId
    ? 'listening_history.started_at DESC'
    : `${sortSql}, title COLLATE NOCASE ASC`;
  const rows = db.prepare(`${sql} ORDER BY ${orderSql} LIMIT ?`).all(...params, Math.max(1, Math.min(100, Number(limit) || 50)));
  res.json({ tracks: rows.map((track) => serializeTrack(track, userId)) });
});

app.get('/api/tracks/:id', (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });
  res.json({ track: serializeTrack(track, req.user ? req.user.id : null) });
});

app.get('/api/tracks/:id/audio', async (req, res) => {
  const track = db.prepare('SELECT audio_url FROM tracks WHERE id = ? AND is_public = 1').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  if (track.audio_url.startsWith('/uploads/')) {
    const filename = path.basename(track.audio_url);
    return res.sendFile(path.join(uploadsDir, filename), (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).json({ error: 'Audio source is unavailable.' });
    });
  }

  try {
    const requestHeaders = {};
    if (req.headers.range) {
      requestHeaders.Range = req.headers.range;
    }

    const upstream = await fetch(track.audio_url, { headers: requestHeaders });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Audio source is unavailable.' });
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error('Audio proxy error:', error);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Unable to stream audio.' });
    } else {
      res.end();
    }
  }
});

app.post('/api/tracks/:id/like', authMiddleware, (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?').get(req.user.id, track.id);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(req.user.id, track.id);
    return res.json({ liked: false, track_id: track.id });
  }

  db.prepare('INSERT INTO likes (user_id, track_id) VALUES (?, ?)').run(req.user.id, track.id);
  return res.json({ liked: true, track_id: track.id });
});

app.get('/api/liked', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT tracks.*
    FROM tracks
    INNER JOIN likes ON likes.track_id = tracks.id
    WHERE likes.user_id = ? AND tracks.deleted_at IS NULL
    ORDER BY likes.created_at DESC
  `).all(req.user.id);
  res.json({ tracks: rows.map((track) => serializeTrack(track, req.user.id)) });
});

app.post('/api/tracks/:id/history', authMiddleware, (req, res) => {
  const { source = 'queue', durationPlayedSeconds = 0, completionPercentage = 0, sessionId = null } = req.body || {};
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const startedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO listening_history (id, user_id, track_id, started_at, ended_at, duration_played_seconds, completion_percentage, source, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(generateId(), req.user.id, track.id, startedAt, new Date().toISOString(), Number(durationPlayedSeconds), Number(completionPercentage), source, sessionId);

  db.prepare('UPDATE tracks SET play_count = play_count + 1 WHERE id = ?').run(track.id);

  db.prepare('INSERT INTO playback_events (id, user_id, track_id, event_type, playback_position_seconds, session_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(generateId(), req.user.id, track.id, 'play', Number(durationPlayedSeconds), sessionId || null);

  res.json({ ok: true, track_id: track.id });
});

app.get('/api/history/recent', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT tracks.*
    FROM listening_history
    INNER JOIN tracks ON tracks.id = listening_history.track_id
    WHERE listening_history.user_id = ? AND tracks.deleted_at IS NULL
    ORDER BY listening_history.started_at DESC
    LIMIT 20
  `).all(req.user.id);
  res.json({ tracks: rows.map((track) => serializeTrack(track, req.user.id)) });
});

app.post('/api/tracks/:id/hide', authMiddleware, (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const reason = req.body?.reason || 'dont_recommend';
  db.prepare(`
    INSERT OR IGNORE INTO hidden_tracks (user_id, track_id, reason)
    VALUES (?, ?, ?)
  `).run(req.user.id, track.id, reason);

  res.json({ hidden: true, track_id: track.id, reason });
});

app.get('/api/recommendations', authMiddleware, (req, res) => {
  const limit = Number(req.query.limit || 12);
  const userId = req.user.id;
  const likedGenres = db.prepare(`
    SELECT t.genre, COUNT(*) AS c
    FROM likes l
    INNER JOIN tracks t ON t.id = l.track_id
    WHERE l.user_id = ?
    GROUP BY t.genre
    ORDER BY c DESC
  `).all(userId);

  const likedTrackIds = db.prepare('SELECT track_id FROM likes WHERE user_id = ?').all(userId).map((row) => row.track_id);
  const hiddenTrackIds = db.prepare('SELECT track_id FROM hidden_tracks WHERE user_id = ?').all(userId).map((row) => row.track_id);

  let sql = 'SELECT * FROM tracks WHERE is_public = 1';
  const params = [];

  if (likedTrackIds.length) {
    sql += ` AND id NOT IN (${Array(likedTrackIds.length).fill('?').join(',')})`;
    params.push(...likedTrackIds);
  }

  if (hiddenTrackIds.length) {
    sql += ` AND id NOT IN (${Array(hiddenTrackIds.length).fill('?').join(',')})`;
    params.push(...hiddenTrackIds);
  }

  const rows = db.prepare(`${sql} ORDER BY play_count DESC, created_at DESC LIMIT ?`).all(...params, Number(limit));

  const genreWeights = new Map(likedGenres.map((entry) => [entry.genre, entry.c]));
  const sorted = rows
    .map((track) => ({
      track,
      score: (genreWeights.get(track.genre) || 0) * 3 + track.play_count * 0.02
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ track }) => serializeTrack(track, userId));

  res.json({ recommendations: sorted.length ? sorted : getTrendingTracks(userId, limit) });
});

app.get('/api/recommendations/trending', (req, res) => {
  const limit = Number(req.query.limit || 20);
  const userId = req.user ? req.user.id : null;
  res.json({ recommendations: getTrendingTracks(userId, limit) });
});

app.get('/api/recommendations/because-you-played/:trackId', authMiddleware, (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Track not found.' });
  const rows = db.prepare(`
    SELECT * FROM tracks
    WHERE id != ?
      AND genre = ?
      AND is_public = 1
      AND NOT EXISTS (SELECT 1 FROM hidden_tracks WHERE user_id = ? AND track_id = tracks.id)
    ORDER BY play_count DESC
    LIMIT 10
  `).all(track.id, track.genre, req.user.id);

  res.json({ recommendations: rows.map((item) => serializeTrack(item, req.user.id)) });
});

app.get('/api/recommendations/for-you', authMiddleware, (req, res) => {
  const limit = Number(req.query.limit || 12);
  const trends = getTrendingTracks(req.user.id, limit);
  res.json({ recommendations: trends });
});

function getTrendingTracks(userId, limit) {
  const hidden = userId
    ? db.prepare('SELECT track_id FROM hidden_tracks WHERE user_id = ?').all(userId).map((row) => row.track_id)
    : [];

  const sql = `
    SELECT * FROM tracks
    WHERE is_public = 1
    ${hidden.length ? `AND id NOT IN (${Array(hidden.length).fill('?').join(',')})` : ''}
    ORDER BY play_count DESC, created_at DESC
    LIMIT ?
  `;

  const params = [...hidden, Number(limit)];
  const rows = db.prepare(sql).all(...params);
  return rows.map((track) => serializeTrack(track, userId));
}

app.get('/api/preferences', authMiddleware, (req, res) => {
  const prefs = getUserPreferences(req.user.id);
  res.json({ preferences: prefs });
});

app.put('/api/preferences', authMiddleware, (req, res) => {
  const { volume, shuffleEnabled, repeatMode, darkMode } = req.body || {};
  const prefs = getUserPreferences(req.user.id);
  const next = {
    volume: Number.isFinite(Number(volume)) ? Math.max(0, Math.min(100, Number(volume))) : prefs.volume,
    shuffle_enabled: typeof shuffleEnabled === 'boolean' ? Number(shuffleEnabled) : Number(prefs.shuffle_enabled),
    repeat_mode: ['off', 'all', 'one'].includes(repeatMode) ? repeatMode : prefs.repeat_mode,
    dark_mode: typeof darkMode === 'boolean' ? Number(darkMode) : Number(prefs.dark_mode)
  };

  db.prepare(`
    INSERT INTO user_preferences (user_id, volume, shuffle_enabled, repeat_mode, dark_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      volume = excluded.volume,
      shuffle_enabled = excluded.shuffle_enabled,
      repeat_mode = excluded.repeat_mode,
      dark_mode = excluded.dark_mode,
      updated_at = excluded.updated_at
  `).run(req.user.id, next.volume, next.shuffle_enabled, next.repeat_mode, next.dark_mode, new Date().toISOString());

  res.json({ preferences: { ...next, user_id: req.user.id, updated_at: new Date().toISOString() } });
});

app.get('/api/playlists', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ playlists: rows });
});

app.post('/api/playlists', authMiddleware, (req, res) => {
  const { name, description, isPublic } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Playlist name is required.' });

  const playlistId = generateId();
  db.prepare(`
    INSERT INTO playlists (id, user_id, name, description, cover_url, is_public)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(playlistId, req.user.id, String(name), description || '', '', Boolean(isPublic) ? 1 : 0);

  res.status(201).json({ playlist: { id: playlistId, user_id: req.user.id, name, description, is_public: Boolean(isPublic) ? 1 : 0 } });
});

app.post('/api/playlists/:playlistId/tracks', authMiddleware, (req, res) => {
  const { trackId } = req.body || {};
  if (!trackId) return res.status(400).json({ error: 'trackId is required.' });

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.playlistId, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  const maxPosition = db.prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM playlist_tracks WHERE playlist_id = ?').get(req.params.playlistId).maxPos;
  db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(req.params.playlistId, trackId, maxPosition + 1);

  res.json({ ok: true, track_id: trackId, playlist_id: req.params.playlistId });
});

app.get('/api/playlists/:playlistId', authMiddleware, (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.playlistId, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

  const tracks = db.prepare(`
    SELECT tracks.*
    FROM playlist_tracks
    INNER JOIN tracks ON tracks.id = playlist_tracks.track_id
    WHERE playlist_tracks.playlist_id = ?
    ORDER BY playlist_tracks.position ASC
  `).all(req.params.playlistId);

  res.json({ playlist, tracks: tracks.map((track) => serializeTrack(track, req.user.id)) });
});

app.put('/api/playlists/:playlistId', authMiddleware, (req, res) => {
  const { name, description, isPublic } = req.body || {};
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.playlistId, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });
  if (name !== undefined && (!String(name).trim() || String(name).length > 255)) {
    return res.status(400).json({ error: 'Playlist name must be between 1 and 255 characters.' });
  }

  db.prepare(`
    UPDATE playlists
    SET name = ?, description = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    name === undefined ? playlist.name : String(name).trim(),
    description === undefined ? playlist.description : String(description),
    isPublic === undefined ? playlist.is_public : (isPublic ? 1 : 0),
    req.params.playlistId,
    req.user.id
  );

  res.json({
    playlist: db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.playlistId)
  });
});

app.delete('/api/playlists/:playlistId', authMiddleware, (req, res) => {
  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
    .get(req.params.playlistId, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });
  db.transaction(() => {
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(req.params.playlistId);
    db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(req.params.playlistId, req.user.id);
  })();
  res.status(204).end();
});

app.delete('/api/playlists/:playlistId/tracks/:trackId', authMiddleware, (req, res) => {
  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(req.params.playlistId, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });

  const result = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
    .run(req.params.playlistId, req.params.trackId);
  if (!result.changes) return res.status(404).json({ error: 'Track is not in this playlist.' });

  const remaining = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC')
    .all(req.params.playlistId);
  const reorder = db.transaction((items) => {
    const update = db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?');
    items.forEach((item, index) => update.run(index, req.params.playlistId, item.track_id));
  });
  reorder(remaining);
  res.status(204).end();
});

app.put('/api/playlists/:playlistId/tracks/reorder', authMiddleware, (req, res) => {
  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(req.params.playlistId, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });
  const trackIds = req.body?.trackIds;
  if (!Array.isArray(trackIds) || trackIds.length > 500 || new Set(trackIds).size !== trackIds.length) {
    return res.status(400).json({ error: 'trackIds must be a unique array of up to 500 tracks.' });
  }

  const existing = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').all(req.params.playlistId).map((row) => row.track_id);
  if (existing.length !== trackIds.length || existing.some((id) => !trackIds.includes(id))) {
    return res.status(400).json({ error: 'trackIds must contain exactly the tracks currently in the playlist.' });
  }

  const reorder = db.transaction((ids) => {
    const update = db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?');
    ids.forEach((trackId, index) => update.run(index + 1000, req.params.playlistId, trackId));
    ids.forEach((trackId, index) => update.run(index, req.params.playlistId, trackId));
  });
  reorder(trackIds);
  res.json({ ok: true, trackIds });
});

app.get('/api/playlists/:playlistId/share', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND is_public = 1').get(req.params.playlistId);
  if (!playlist) return res.status(404).json({ error: 'Public playlist not found.' });
  const tracks = db.prepare(`
    SELECT tracks.*
    FROM playlist_tracks
    INNER JOIN tracks ON tracks.id = playlist_tracks.track_id
    WHERE playlist_tracks.playlist_id = ? AND tracks.is_public = 1
    ORDER BY playlist_tracks.position ASC
  `).all(req.params.playlistId);
  res.json({ playlist, tracks: tracks.map((track) => serializeTrack(track)) });
});

app.post('/api/playback/event', authMiddleware, (req, res) => {
  const { trackId, eventType, playbackPositionSeconds = 0, sessionId = null } = req.body || {};
  if (!trackId || !eventType) return res.status(400).json({ error: 'trackId and eventType are required.' });

  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
  if (!track) return res.status(404).json({ error: 'Track not found.' });

  db.prepare('INSERT INTO playback_events (id, user_id, track_id, event_type, playback_position_seconds, session_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(generateId(), req.user.id, trackId, String(eventType), Number(playbackPositionSeconds), sessionId || null);

  res.json({ ok: true, event_type: eventType });
});

app.get('/api/analytics/summary', authMiddleware, (req, res) => {
  const stats = {
    likedSongs: db.prepare('SELECT COUNT(*) AS count FROM likes WHERE user_id = ?').get(req.user.id).count,
    streamedHours: Math.floor((db.prepare('SELECT COALESCE(SUM(duration_played_seconds), 0) AS total FROM listening_history WHERE user_id = ?').get(req.user.id).total || 0) / 3600),
    topGenre: db.prepare(`
      SELECT t.genre, COUNT(*) AS count
      FROM listening_history h
      INNER JOIN tracks t ON t.id = h.track_id
      WHERE h.user_id = ?
      GROUP BY t.genre
      ORDER BY count DESC
      LIMIT 1
    `).get(req.user.id)
  };

  res.json({ stats });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Uploaded file is too large. Audio files must be 100 MB or smaller.'
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Only one audio file and one cover image are allowed.'
        : 'Invalid upload.';
    return res.status(400).json({ error: message });
  }
  if (err.message && err.message.startsWith('Invalid ')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`IKSA Player backend listening on http://localhost:${port}`);
});
