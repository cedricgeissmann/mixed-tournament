'use strict';

/**
 * Admin API routes — protected by a simple password check.
 */

const express = require('express');
const { stmts, db } = require('../db');
const tournament = require('../tournament');

const router = express.Router();

// ── Password middleware ───────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

  // Check session cookie
  if (req.cookies && req.cookies.admin_auth === ADMIN_PASSWORD) {
    return next();
  }
  // Allow Bearer token too (for API calls from admin.html)
  const auth = req.headers['x-admin-password'];
  if (auth === ADMIN_PASSWORD) {
    return next();
  }

  // Return 401 for API calls, redirect for page requests
  if (req.path === '/login' || req.method === 'POST') {
    return next(); // login route handles itself
  }
  res.status(401).json({ error: 'Unauthorized.' });
}

// ── POST /admin/api/login ─────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
  if (password === ADMIN_PASSWORD) {
    res.cookie('admin_auth', password, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password.' });
  }
});

// ── POST /admin/api/logout ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('admin_auth');
  res.json({ ok: true });
});

// All routes below require auth
router.use(requireAdmin);

// ── GET /admin/api/state ──────────────────────────────────────────────────────
router.get('/state', (req, res) => {
  const state = tournament.getState();
  const roundData = tournament.getCurrentRoundData();
  res.json({ state, round: roundData });
});

// ── GET /admin/api/players ────────────────────────────────────────────────────
router.get('/players', (req, res) => {
  const players = stmts.getAllPlayers.all();
  const requests = stmts.getBreakRequests.all();
  const requestIds = new Set(requests.map(r => r.player_id));

  const result = players.map(p => ({
    id: p.id,
    name: p.name,
    clubTeam: p.club_team,
    active: p.active === 1,
    paused: p.paused === 1,
    totalBreaks: stmts.countPlayerBreaks.get(p.id).cnt,
    hasBreakRequest: requestIds.has(p.id),
    createdAt: p.created_at,
  }));

  res.json({ players: result });
});

// ── POST /admin/api/tournament/start ─────────────────────────────────────────
router.post('/tournament/start', (req, res) => {
  try {
    const roundData = tournament.startTournament();
    res.json({ ok: true, round: roundData });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /admin/api/tournament/next ──────────────────────────────────────────
router.post('/tournament/next', (req, res) => {
  try {
    const roundData = tournament.nextRound();
    res.json({ ok: true, round: roundData });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /admin/api/tournament/finish ─────────────────────────────────────────
router.post('/tournament/finish', (req, res) => {
  try {
    tournament.finishTournament();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /admin/api/tournament/reset ─────────────────────────────────────────
router.post('/tournament/reset', (req, res) => {
  try {
    tournament.resetTournament();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── DELETE /admin/api/players/:id ─────────────────────────────────────────────
router.delete('/players/:id', (req, res) => {
  const player = stmts.getPlayerById.get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  db.prepare('UPDATE players SET active = 0 WHERE id = ?').run(player.id);
  stmts.removeBreakRequest.run(player.id);
  res.json({ ok: true });
});

// ── POST /admin/api/players/:id/pause ─────────────────────────────────────────
router.post('/players/:id/pause', (req, res) => {
  const player = stmts.getPlayerById.get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (!player.active) return res.status(400).json({ error: 'Player is not active.' });

  stmts.pausePlayer.run(player.id);
  res.json({ ok: true });
});

// ── POST /admin/api/players/:id/unpause ───────────────────────────────────────
router.post('/players/:id/unpause', (req, res) => {
  const player = stmts.getPlayerById.get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  stmts.unpausePlayer.run(player.id);
  res.json({ ok: true });
});

// ── GET /admin/api/stats ──────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const coPlay = stmts.getAllCoPlay.all();
  const state = tournament.getState();
  const rounds = stmts.getAllRounds.all();

  res.json({
    totalRounds: rounds.length,
    tournamentStatus: state.status,
    currentRound: state.current_round,
    coPlayStats: coPlay.map(c => ({
      playerA: c.name_a,
      playerB: c.name_b,
      count: c.count,
      lastRound: c.last_round,
    })),
  });
});

module.exports = router;
