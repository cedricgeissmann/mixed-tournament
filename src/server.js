'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');

const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API routes ────────────────────────────────────────────────────────────────

app.use('/api', apiRouter);
app.use('/admin/api', adminRouter);

// ── QR code endpoint ──────────────────────────────────────────────────────────
// Generates a QR code image for a given URL path.

app.get('/qr', async (req, res) => {
  const targetPath = req.query.path || '/register';
  const url = `${BASE_URL}${targetPath}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', width: 300 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

// ── Page routes ───────────────────────────────────────────────────────────────
// Serve HTML pages explicitly so that all unknown paths fall through to 404.

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ── Server info endpoint ──────────────────────────────────────────────────────
app.get('/api/server-info', (req, res) => {
  res.json({ baseUrl: BASE_URL });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mixed Tournament server running on port ${PORT}`);
  console.log(`Main display: ${BASE_URL}/`);
  console.log(`Admin panel:  ${BASE_URL}/admin`);
  console.log(`Register:     ${BASE_URL}/register`);
});
