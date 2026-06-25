'use strict';

/**
 * High-level tournament state machine.
 */

const { db, stmts, runInTransaction } = require('./db');
const { generateRound } = require('./teamBuilder');

/**
 * Get the current tournament state (status + current_round).
 */
function getState() {
  return stmts.getTournamentState.get();
}

/**
 * Start the tournament (transition from 'waiting' to 'active') and
 * generate the first round. Throws if already started.
 */
function startTournament() {
  const state = getState();
  if (state.status !== 'waiting') {
    throw new Error('Tournament has already started.');
  }

  return runInTransaction(() => {
    stmts.setTournamentStatus.run('active');
    stmts.incrementRound.run();
    const newState = getState();
    const roundNum = newState.current_round;

    const roundResult = stmts.insertRound.run(roundNum);
    const roundId = roundResult.lastInsertRowid;

    generateRound(roundId, roundNum);

    // Activate the round immediately
    stmts.activateRound.run(roundId);

    return getFullRoundData(roundNum);
  });
}

/**
 * Advance to the next round. Finishes the current round, creates a new one.
 */
function nextRound() {
  const state = getState();
  if (state.status !== 'active') {
    throw new Error('Tournament is not active.');
  }

  return runInTransaction(() => {
    // Finish current round
    const currentRound = stmts.getRoundByNum.get(state.current_round);
    if (currentRound) {
      stmts.finishRound.run(currentRound.id);
    }

    // Create and generate next round
    stmts.incrementRound.run();
    const newState = getState();
    const roundNum = newState.current_round;

    const roundResult = stmts.insertRound.run(roundNum);
    const roundId = roundResult.lastInsertRowid;

    generateRound(roundId, roundNum);
    stmts.activateRound.run(roundId);

    return getFullRoundData(roundNum);
  });
}

/**
 * Finish the tournament.
 */
function finishTournament() {
  const state = getState();
  if (state.status !== 'active') {
    throw new Error('Tournament is not active.');
  }

  runInTransaction(() => {
    const currentRound = stmts.getRoundByNum.get(state.current_round);
    if (currentRound) {
      stmts.finishRound.run(currentRound.id);
    }
    stmts.setTournamentStatus.run('finished');
  });
}

/**
 * Reset the entire tournament (for development / re-use).
 */
function resetTournament() {
  runInTransaction(() => {
    db.exec('DELETE FROM break_requests');
    db.exec('DELETE FROM co_play_history');
    db.exec('DELETE FROM break_assignments');
    db.exec('DELETE FROM team_assignments');
    db.exec('DELETE FROM rounds');
    db.exec('DELETE FROM players');
    db.exec(`UPDATE tournament_state SET status = 'waiting', current_round = 0 WHERE id = 1`);
  });
}

/**
 * Build the full structured data for a given round number.
 * Returns null if no round exists.
 */
function getFullRoundData(roundNum) {
  const round = stmts.getRoundByNum.get(roundNum);
  if (!round) return null;

  const assignments = stmts.getTeamAssignmentsByRound.all(round.id);
  const breaks = stmts.getBreaksByRound.all(round.id);

  // Group by court
  const courtMap = {};
  for (const a of assignments) {
    if (!courtMap[a.court_num]) {
      courtMap[a.court_num] = { courtNum: a.court_num, teams: {} };
    }
    if (!courtMap[a.court_num].teams[a.team_num]) {
      courtMap[a.court_num].teams[a.team_num] = [];
    }
    courtMap[a.court_num].teams[a.team_num].push({
      id: a.player_id,
      name: a.name,
      clubTeam: a.club_team,
      token: a.token,
    });
  }

  const courts = Object.values(courtMap)
    .sort((a, b) => a.courtNum - b.courtNum)
    .map(c => ({
      courtNum: c.courtNum,
      teams: Object.entries(c.teams)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([teamNum, players]) => ({ teamNum: Number(teamNum), players })),
    }));

  return {
    roundNum: round.round_num,
    status: round.status,
    courts,
    breaking: breaks.map(b => ({
      id: b.player_id,
      name: b.name,
      token: b.token,
      voluntary: b.voluntary === 1,
    })),
  };
}

/**
 * Get the current round data (or null if no active round).
 */
function getCurrentRoundData() {
  const state = getState();
  if (state.current_round === 0) return null;
  return getFullRoundData(state.current_round);
}

/**
 * Get what a specific player is doing in the current round.
 */
function getPlayerCurrentAssignment(playerId) {
  const state = getState();
  if (state.status === 'waiting') {
    return { status: 'waiting' };
  }
  if (state.status === 'finished') {
    return { status: 'finished' };
  }

  const round = stmts.getRoundByNum.get(state.current_round);
  if (!round) return { status: 'waiting' };

  // Check if on break
  const onBreak = stmts.getPlayerBreakInRound.get(round.id, playerId);
  if (onBreak) {
    return {
      status: 'break',
      roundNum: round.round_num,
      voluntary: onBreak.voluntary === 1,
    };
  }

  // Check team assignment
  const assignment = stmts.getPlayerAssignmentInRound.get(round.id, playerId);
  if (assignment) {
    return {
      status: 'playing',
      roundNum: round.round_num,
      courtNum: assignment.court_num,
      teamNum: assignment.team_num,
    };
  }

  // Player was not active when round was generated (joined after round started)
  return { status: 'pending', roundNum: round.round_num };
}

module.exports = {
  getState,
  startTournament,
  nextRound,
  finishTournament,
  resetTournament,
  getCurrentRoundData,
  getFullRoundData,
  getPlayerCurrentAssignment,
};
