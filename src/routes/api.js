'use strict';

/**
 * Public API routes (no auth required).
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { stmts } = require('../db');
const tournament = require('../tournament');

const router = express.Router();

// Load club teams from config
let clubTeams = [];
try {
  clubTeams = require('../../teams.json');
} catch {
  clubTeams = ['Team A', 'Team B', 'Team C'];
}

// ── GET /api/teams ────────────────────────────────────────────────────────────
// Returns the list of club teams for the registration dropdown.
router.get('/teams', (req, res) => {
  res.json({ teams: clubTeams });
});

// ── POST /api/register ────────────────────────────────────────────────────────
// Register a new player. Returns a token stored by the client.
router.post('/register', (req, res) => {
  const { name, clubTeam } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (!clubTeam || !clubTeams.includes(clubTeam)) {
    return res.status(400).json({ error: 'Invalid club team.' });
  }

  const token = uuidv4();
  try {
    stmts.insertPlayer.run(token, name.trim(), clubTeam);
    const player = stmts.getPlayerByToken.get(token);
    res.json({
      token,
      player: {
        id: player.id,
        name: player.name,
        clubTeam: player.club_team,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// ── GET /api/player/:token ────────────────────────────────────────────────────
// Get player info + current round assignment.
router.get('/player/:token', (req, res) => {
  const player = stmts.getPlayerByToken.get(req.params.token);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (!player.active) return res.status(410).json({ error: 'Player has left the tournament.' });

  const assignment = tournament.getPlayerCurrentAssignment(player.id);
  const hasBreakRequest = !!stmts.hasBreakRequest.get(player.id);
  const totalBreaks = stmts.countPlayerBreaks.get(player.id).cnt;
  const state = tournament.getState();

  res.json({
    player: {
      id: player.id,
      name: player.name,
      clubTeam: player.club_team,
      paused: player.paused === 1,
    },
    tournamentStatus: state.status,
    currentRound: state.current_round,
    assignment,
    hasBreakRequest,
    totalBreaks,
  });
});

// ── POST /api/player/:token/break ─────────────────────────────────────────────
// Request or cancel a voluntary break for the next round.
router.post('/player/:token/break', (req, res) => {
  const player = stmts.getPlayerByToken.get(req.params.token);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (!player.active) return res.status(410).json({ error: 'Player has left the tournament.' });

  const { request } = req.body; // true = request break, false = cancel

  if (request) {
    stmts.addBreakRequest.run(player.id);
    res.json({ message: 'Break request registered.' });
  } else {
    stmts.removeBreakRequest.run(player.id);
    res.json({ message: 'Break request cancelled.' });
  }
});

// ── DELETE /api/player/:token ─────────────────────────────────────────────────
// Unregister / leave the tournament.
router.delete('/player/:token', (req, res) => {
  const player = stmts.getPlayerByToken.get(req.params.token);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  stmts.deactivatePlayer.run(req.params.token);
  stmts.removeBreakRequest.run(player.id);
  res.json({ message: 'You have left the tournament.' });
});

// ── GET /api/round/current ────────────────────────────────────────────────────
// Get the current round data (courts, teams, breaks).
router.get('/round/current', (req, res) => {
  const data = tournament.getCurrentRoundData();
  const state = tournament.getState();
  res.json({
    tournamentStatus: state.status,
    currentRound: state.current_round,
    round: data,
  });
});

module.exports = router;
