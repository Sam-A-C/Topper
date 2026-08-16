'use strict';

const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const db = require('./db');

// ─────────────────────────────────────────────────────────────────────────
// Google sign-in.
//
// Flow: the browser gets an ID token from Google Identity Services, posts it
// to /api/auth/google, we verify it against Google's keys, upsert the user,
// and hand back our own short JWT session. We never see or store a password.
//
// Auth is OPTIONAL throughout: without it the app records battles in memory
// exactly as before. Signing in is what makes a battle durable.
// ─────────────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET   = process.env.SESSION_SECRET || '';
const SESSION_DAYS     = 30;

const enabled = !!(GOOGLE_CLIENT_ID && SESSION_SECRET && db.enabled);

const client = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function status() {
  if (enabled) return { enabled: true, clientId: GOOGLE_CLIENT_ID };
  const missing = [];
  if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!SESSION_SECRET)   missing.push('SESSION_SECRET');
  if (!db.enabled)       missing.push('DATABASE_URL');
  return { enabled: false, missing };
}

async function verifyGoogleToken(credential) {
  if (!client) throw new Error('Google sign-in is not configured.');
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID,
  });
  const p = ticket.getPayload();
  if (!p?.email_verified) throw new Error('Google account email is not verified.');
  return { sub: p.sub, email: p.email, name: p.name, picture: p.picture };
}

function issueSession(user) {
  return jwt.sign(
    { uid: String(user.id), email: user.email, name: user.name, picture: user.picture },
    SESSION_SECRET,
    { expiresIn: `${SESSION_DAYS}d` });
}

function readSession(token) {
  if (!token || !SESSION_SECRET) return null;
  try { return jwt.verify(token, SESSION_SECRET); }
  catch { return null; }
}

const COOKIE = 'topper_session';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

// Express middleware — attaches req.user when a valid session is present.
function attachUser(req, _res, next) {
  req.user = readSession(req.cookies?.[COOKIE]);
  next();
}

// Routes are mounted by server.js.
function routes(app) {
  app.get('/api/auth/config', (_req, res) => res.json(status()));

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user ?? null, auth: status() });
  });

  app.post('/api/auth/google', async (req, res) => {
    if (!enabled) {
      return res.status(503).json({ error: 'Sign-in is not configured on this server.' });
    }
    try {
      const profile = await verifyGoogleToken(req.body?.credential);
      const user = await db.upsertUser(profile);
      res.cookie(COOKIE, issueSession(user), cookieOptions());
      res.json({ user: { uid: String(user.id), email: user.email,
                         name: user.name, picture: user.picture } });
    } catch (err) {
      res.status(401).json({ error: err.message || 'Sign-in failed.' });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  });

  app.get('/api/battles', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to list saved battles.' });
    try { res.json({ battles: await db.listBattles(req.user.uid) }); }
    catch { res.status(500).json({ error: 'Could not load battles.' }); }
  });
}

// Socket.io handshake — cookies come through on the handshake headers.
function userFromHandshake(socket) {
  const raw = socket.handshake.headers?.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!match) return null;
  return readSession(decodeURIComponent(match.slice(COOKIE.length + 1)));
}

module.exports = { enabled, status, routes, attachUser, userFromHandshake, COOKIE };
