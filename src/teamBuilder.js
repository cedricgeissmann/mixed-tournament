'use strict';

/**
 * Team builder for the mixed volleyball tournament.
 *
 * Rules:
 *  - 3 courts, 6 teams (2 per court), each team ideally 6 players
 *  - If players > 36: excess players take a break
 *  - If players < 36: fill as many teams of 6 as possible; smaller teams
 *    fill the remaining slots and are paired together on the same court
 *  - Break constraints:
 *      1. No player breaks twice in a row
 *      2. No player breaks more than once total (unless everyone has broken once)
 *      3. Voluntary break requests are honoured first
 *      4. A second break is only given if all other players have had at least 1
 *  - Co-play constraints (soft):
 *      - Prefer not to put two players together if they played together last round
 *      - Prefer not to put two players together more than 4 times total
 *      - Hard: never more than 2 consecutive rounds together (approximated via last_round)
 */

const { stmts, getCoPlayCount, recordCoPlay, getLastCoPlayRound } = require('./db');

const COURTS = 3;
const TEAMS_PER_COURT = 2;
const TOTAL_TEAMS = COURTS * TEAMS_PER_COURT; // 6
const IDEAL_TEAM_SIZE = 6;
const MAX_PLAYERS = TOTAL_TEAMS * IDEAL_TEAM_SIZE; // 36

/**
 * Shuffle an array in place (Fisher-Yates).
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Determine which players take a break this round.
 *
 * @param {Array}  players      - All active players [{id, name, ...}]
 * @param {number} roundNum     - Current round number (1-based)
 * @param {Set}    voluntaryIds - Set of player IDs who requested a break
 * @returns {{ playing: Array, breaking: Array }}
 */
function assignBreaks(players, roundNum, voluntaryIds) {
  const playingCount = Math.min(players.length, MAX_PLAYERS);
  const breakCount = players.length - playingCount;

  if (breakCount === 0 && voluntaryIds.size === 0) {
    return { playing: [...players], breaking: [] };
  }

  // Count existing breaks and last break round for each player
  const breakInfo = players.map(p => {
    const totalBreaks = stmts.countPlayerBreaks.get(p.id).cnt;
    const lastBreakRow = stmts.getLastBreakRound.get(p.id);
    const lastBreak = lastBreakRow ? (lastBreakRow.last_break || 0) : 0;
    return {
      ...p,
      totalBreaks,
      lastBreak,
      hasBreakRequest: voluntaryIds.has(p.id),
    };
  });

  const breaking = [];
  const available = [...breakInfo];

  // Helper: can this player be given a break?
  function canBreak(p, allBreaking) {
    // Never break twice in a row (lastBreak 0 means never broken, so only block if > 0)
    if (p.lastBreak > 0 && p.lastBreak === roundNum - 1) return false;
    // Never more than 1 break total unless everyone has had at least 1
    if (p.totalBreaks >= 1) {
      const minBreaks = Math.min(...breakInfo.map(x => x.totalBreaks));
      if (minBreaks < 1) return false; // others haven't broken yet
    }
    return true;
  }

  // Step 1: honour voluntary break requests (if constraints allow)
  for (const p of breakInfo) {
    if (p.hasBreakRequest && canBreak(p, breaking)) {
      breaking.push(p);
    }
  }

  // Step 2: if we still need more breaks, pick players with fewest total breaks
  // (and never back-to-back), sorted by: fewest breaks first, then randomise ties
  let needMore = breakCount - breaking.length;
  if (needMore > 0) {
    const candidates = available
      .filter(p => !breaking.find(b => b.id === p.id))
      .filter(p => canBreak(p, breaking))
      .sort((a, b) => {
        if (a.totalBreaks !== b.totalBreaks) return a.totalBreaks - b.totalBreaks;
        return Math.random() - 0.5;
      });

    for (const p of candidates) {
      if (needMore <= 0) break;
      breaking.push(p);
      needMore--;
    }
  }

  // If voluntary breaks push us above the breakCount, that's fine — fewer
  // players play, meaning teams may be slightly smaller.
  const breakingIds = new Set(breaking.map(p => p.id));
  const playing = players.filter(p => !breakingIds.has(p.id));

  return { playing, breaking };
}

/**
 * Score a candidate team assignment for a player being added.
 * Lower score = better (fewer constraint violations).
 *
 * @param {number}  playerId
 * @param {Array}   currentTeammates  - player IDs already on this team
 * @param {number}  roundNum
 */
function scorePlayerTeamFit(playerId, currentTeammates, roundNum) {
  let score = 0;
  for (const tmId of currentTeammates) {
    const total = getCoPlayCount(playerId, tmId);
    const last = getLastCoPlayRound(playerId, tmId);

    // Hard penalty: played together last round (consecutive)
    if (last === roundNum - 1) score += 100;
    // Soft penalty: played together 4+ times
    if (total >= 4) score += 20;
    // Small penalty: played together 3 times
    if (total >= 3) score += 5;
    // Tiny penalty: played together at all
    if (total >= 1) score += 1;
  }
  return score;
}

/**
 * Build 6 teams from the playing players using a greedy + shuffled approach.
 *
 * Returns an array of 6 teams, each being an array of player objects.
 * Teams are sorted largest-first so that smaller teams end up paired together.
 */
function buildTeams(playing, roundNum) {
  const playerCount = playing.length;

  // Determine team sizes: fill as many 6-player teams as possible
  const fullTeams = Math.floor(playerCount / IDEAL_TEAM_SIZE);
  const remainder = playerCount % IDEAL_TEAM_SIZE;

  // We always want exactly 6 teams
  // Example: 30 players → 5 full + 1 team of 0 → adjust:
  //   if fullTeams >= 6, all 6 teams get 6 (or 5 overflow to break already)
  //   if fullTeams < 6, some teams get fewer players

  // Build a sizes array of length 6
  const sizes = [];
  for (let i = 0; i < TOTAL_TEAMS; i++) {
    if (i < fullTeams) {
      sizes.push(IDEAL_TEAM_SIZE);
    } else if (i === fullTeams && remainder > 0) {
      sizes.push(remainder);
    } else {
      sizes.push(0); // empty team (won't happen if break logic is correct, but defensive)
    }
  }

  // Sort sizes descending so larger teams fill first
  sizes.sort((a, b) => b - a);

  // Filter out zero-size teams (shouldn't happen but be safe)
  const activeSizes = sizes.filter(s => s > 0);
  while (activeSizes.length < TOTAL_TEAMS) activeSizes.push(0);

  // Shuffle players before assignment
  const shuffled = shuffle([...playing]);

  // Greedy assignment: for each player (in shuffled order), assign to the
  // team where they fit best (lowest score) and that still needs members
  const teams = Array.from({ length: TOTAL_TEAMS }, () => []);
  const teamCapacity = activeSizes;

  for (const player of shuffled) {
    // Find teams that still have room
    const eligibleTeams = teams
      .map((t, idx) => ({ idx, team: t }))
      .filter(({ idx, team }) => team.length < teamCapacity[idx]);

    if (eligibleTeams.length === 0) break; // defensive

    // Score each eligible team
    const scored = eligibleTeams.map(({ idx, team }) => ({
      idx,
      score: scorePlayerTeamFit(player.id, team.map(p => p.id), roundNum),
    }));

    // Pick the best (lowest score); break ties randomly
    scored.sort((a, b) => a.score - b.score || Math.random() - 0.5);
    teams[scored[0].idx].push(player);
  }

  return teams.filter(t => t.length > 0);
}

/**
 * Assign courts to teams.
 * Smaller teams are paired together on the same court.
 *
 * Returns: Array of { courtNum, teamA: [...players], teamB: [...players] }
 */
function assignCourts(teams) {
  // Sort teams by size descending; pairs are (0,1), (2,3), (4,5)
  const sorted = [...teams].sort((a, b) => b.length - a.length);

  const courts = [];
  for (let c = 0; c < COURTS; c++) {
    const teamA = sorted[c * 2] || [];
    const teamB = sorted[c * 2 + 1] || [];
    courts.push({
      courtNum: c + 1,
      teamA,
      teamB,
    });
  }
  return courts;
}

/**
 * Main entry point: generate round assignments.
 *
 * @param {number} roundId   - DB round id
 * @param {number} roundNum  - Round number (1-based)
 * @returns {object} { courts, breaking }
 */
function generateRound(roundId, roundNum) {
  // Exclude players who are inactive (left) or currently paused by admin
  const allActive = stmts.getParticipatingPlayers.all();

  // Collect voluntary break requests
  const requests = stmts.getBreakRequests.all();
  const voluntaryIds = new Set(requests.map(r => r.player_id));

  // Assign breaks
  const { playing, breaking } = assignBreaks(allActive, roundNum, voluntaryIds);

  // Build teams
  const teams = buildTeams(playing, roundNum);

  // Assign courts (smaller teams paired together)
  const courts = assignCourts(teams);

  // Persist assignments to DB (called within an existing transaction from tournament.js)
  // Team assignments
  for (let ci = 0; ci < courts.length; ci++) {
    const court = courts[ci];
    const teamANum = ci * 2 + 1;
    const teamBNum = ci * 2 + 2;

    for (const p of court.teamA) {
      stmts.insertTeamAssignment.run(roundId, p.id, teamANum, court.courtNum);
    }
    for (const p of court.teamB) {
      stmts.insertTeamAssignment.run(roundId, p.id, teamBNum, court.courtNum);
    }
  }

  // Break assignments
  for (const p of breaking) {
    const isVoluntary = voluntaryIds.has(p.id) ? 1 : 0;
    stmts.insertBreakAssignment.run(roundId, p.id, isVoluntary);
  }

  // Update co-play history
  for (const court of courts) {
    const allTeams = [court.teamA, court.teamB];
    for (const team of allTeams) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          recordCoPlay(team[i].id, team[j].id, roundNum);
        }
      }
    }
  }

  // Clear voluntary break requests now that the round is built
  stmts.clearBreakRequests.run();

  return { courts, breaking };
}

module.exports = { generateRound };
