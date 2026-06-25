'use strict';

// node:sqlite is available as a built-in from Node 22.5+
// No external native module needed.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/tournament.db';

// Ensure the directory exists
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    token     TEXT    NOT NULL UNIQUE,
    name      TEXT    NOT NULL,
    club_team TEXT    NOT NULL,
    active    INTEGER NOT NULL DEFAULT 1,
    paused    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS tournament_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    status         TEXT    NOT NULL DEFAULT 'waiting',
    current_round  INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO tournament_state (id, status, current_round)
  VALUES (1, 'waiting', 0);

  CREATE TABLE IF NOT EXISTS rounds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    round_num  INTEGER NOT NULL UNIQUE,
    status     TEXT    NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS team_assignments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id   INTEGER NOT NULL REFERENCES rounds(id),
    player_id  INTEGER NOT NULL REFERENCES players(id),
    team_num   INTEGER NOT NULL,
    court_num  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS break_assignments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id   INTEGER NOT NULL REFERENCES rounds(id),
    player_id  INTEGER NOT NULL REFERENCES players(id),
    voluntary  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(round_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS co_play_history (
    player_a_id  INTEGER NOT NULL REFERENCES players(id),
    player_b_id  INTEGER NOT NULL REFERENCES players(id),
    count        INTEGER NOT NULL DEFAULT 0,
    last_round   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_a_id, player_b_id),
    CHECK (player_a_id < player_b_id)
  );

  CREATE TABLE IF NOT EXISTS break_requests (
    player_id  INTEGER PRIMARY KEY REFERENCES players(id)
  );
`);

// ── Migrations ────────────────────────────────────────────────────────────────
// Safe to run on every startup against existing DBs that predate this column.
// SQLite throws if the column already exists; we catch and ignore that case.
try {
  db.exec(`ALTER TABLE players ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  if (!e.message.includes('duplicate column name')) throw e;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// node:sqlite uses .prepare() like better-sqlite3 but returns StatementSync.
// API: stmt.get(...args) / stmt.all(...args) / stmt.run(...args)

const stmts = {
  // Players
  insertPlayer: db.prepare(
    `INSERT INTO players (token, name, club_team) VALUES (?, ?, ?)`
  ),
  getPlayerByToken: db.prepare(
    `SELECT * FROM players WHERE token = ?`
  ),
  getPlayerById: db.prepare(
    `SELECT * FROM players WHERE id = ?`
  ),
  getActivePlayers: db.prepare(
    `SELECT * FROM players WHERE active = 1 ORDER BY name`
  ),
  getAllPlayers: db.prepare(
    `SELECT * FROM players ORDER BY name`
  ),
  deactivatePlayer: db.prepare(
    `UPDATE players SET active = 0 WHERE token = ?`
  ),
  pausePlayer: db.prepare(
    `UPDATE players SET paused = 1 WHERE id = ?`
  ),
  unpausePlayer: db.prepare(
    `UPDATE players SET paused = 0 WHERE id = ?`
  ),
  getParticipatingPlayers: db.prepare(
    `SELECT * FROM players WHERE active = 1 AND paused = 0 ORDER BY name`
  ),

  // Tournament state
  getTournamentState: db.prepare(
    `SELECT * FROM tournament_state WHERE id = 1`
  ),
  setTournamentStatus: db.prepare(
    `UPDATE tournament_state SET status = ? WHERE id = 1`
  ),
  incrementRound: db.prepare(
    `UPDATE tournament_state SET current_round = current_round + 1 WHERE id = 1`
  ),

  // Rounds
  insertRound: db.prepare(
    `INSERT INTO rounds (round_num, status) VALUES (?, 'pending')`
  ),
  getRoundByNum: db.prepare(
    `SELECT * FROM rounds WHERE round_num = ?`
  ),
  getLatestRound: db.prepare(
    `SELECT * FROM rounds ORDER BY round_num DESC LIMIT 1`
  ),
  activateRound: db.prepare(
    `UPDATE rounds SET status = 'active' WHERE id = ?`
  ),
  finishRound: db.prepare(
    `UPDATE rounds SET status = 'finished' WHERE id = ?`
  ),
  getAllRounds: db.prepare(
    `SELECT * FROM rounds ORDER BY round_num`
  ),

  // Team assignments
  insertTeamAssignment: db.prepare(
    `INSERT INTO team_assignments (round_id, player_id, team_num, court_num) VALUES (?, ?, ?, ?)`
  ),
  getTeamAssignmentsByRound: db.prepare(
    `SELECT ta.*, p.name, p.club_team, p.token
     FROM team_assignments ta
     JOIN players p ON p.id = ta.player_id
     WHERE ta.round_id = ?
     ORDER BY ta.team_num, p.name`
  ),
  getPlayerAssignmentInRound: db.prepare(
    `SELECT ta.*, p.name
     FROM team_assignments ta
     JOIN players p ON p.id = ta.player_id
     WHERE ta.round_id = ? AND ta.player_id = ?`
  ),

  // Break assignments
  insertBreakAssignment: db.prepare(
    `INSERT INTO break_assignments (round_id, player_id, voluntary) VALUES (?, ?, ?)`
  ),
  getBreaksByRound: db.prepare(
    `SELECT ba.*, p.name, p.token
     FROM break_assignments ba
     JOIN players p ON p.id = ba.player_id
     WHERE ba.round_id = ?`
  ),
  getPlayerBreakInRound: db.prepare(
    `SELECT * FROM break_assignments WHERE round_id = ? AND player_id = ?`
  ),
  countPlayerBreaks: db.prepare(
    `SELECT COUNT(*) as cnt FROM break_assignments WHERE player_id = ?`
  ),
  getLastBreakRound: db.prepare(
    `SELECT MAX(r.round_num) as last_break
     FROM break_assignments ba
     JOIN rounds r ON r.id = ba.round_id
     WHERE ba.player_id = ?`
  ),

  // Co-play history
  getCoPlayEntry: db.prepare(
    `SELECT * FROM co_play_history WHERE player_a_id = ? AND player_b_id = ?`
  ),
  upsertCoPlay: db.prepare(
    `INSERT INTO co_play_history (player_a_id, player_b_id, count, last_round)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(player_a_id, player_b_id)
     DO UPDATE SET count = count + 1, last_round = excluded.last_round`
  ),
  getAllCoPlay: db.prepare(
    `SELECT cp.*, pa.name as name_a, pb.name as name_b
     FROM co_play_history cp
     JOIN players pa ON pa.id = cp.player_a_id
     JOIN players pb ON pb.id = cp.player_b_id
     ORDER BY cp.count DESC`
  ),

  // Break requests
  addBreakRequest: db.prepare(
    `INSERT OR IGNORE INTO break_requests (player_id) VALUES (?)`
  ),
  removeBreakRequest: db.prepare(
    `DELETE FROM break_requests WHERE player_id = ?`
  ),
  getBreakRequests: db.prepare(
    `SELECT br.*, p.name, p.token FROM break_requests br JOIN players p ON p.id = br.player_id`
  ),
  clearBreakRequests: db.prepare(
    `DELETE FROM break_requests`
  ),
  hasBreakRequest: db.prepare(
    `SELECT 1 as found FROM break_requests WHERE player_id = ?`
  ),
};

// ── Co-play helpers ───────────────────────────────────────────────────────────

function getCoPlayCount(aId, bId) {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const row = stmts.getCoPlayEntry.get(lo, hi);
  return row ? row.count : 0;
}

function recordCoPlay(aId, bId, roundNum) {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  stmts.upsertCoPlay.run(lo, hi, roundNum);
}

function getLastCoPlayRound(aId, bId) {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const row = stmts.getCoPlayEntry.get(lo, hi);
  return row ? row.last_round : 0;
}

// ── Transaction helper ────────────────────────────────────────────────────────
// node:sqlite doesn't have a .transaction() wrapper like better-sqlite3,
// so we provide a simple manual helper.

function runInTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = {
  db,
  stmts,
  getCoPlayCount,
  recordCoPlay,
  getLastCoPlayRound,
  runInTransaction,
};
