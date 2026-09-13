(function () {
  "use strict";

  /* ---------- palette (kept for the SVG logo colors) ---------- */
  var BALL_COLOR = "#E8D144";
  var LINE_COLOR = "#F5EFD9";
  var COURT_COLOR = "#2F6E5C";

  var SKILL_LABELS = ["—", "B", "LN", "HN", "LI", "HI"];
  var SKILL_NAMES = ["Unrated", "Beginner", "Low Novice", "High Novice", "Low Intermediate", "High Intermediate"];
  var STARTING_RATING = 3.50;

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function ratingDelta(scoreA, scoreB) {
    var diff = Math.abs(scoreA - scoreB);
    return Math.min(diff, 11) * 0.01;
  }

  /* ---------- state ---------- */
  var state = {
    players: [],
    numCourts: 2,
    sessionStarted: false,
    courts: [],
    matchCounts: [],
    gamesPlayed: {},
    benchOrder: {},
    turnCounter: 0,
    partnerHistory: {},
    opponentHistory: {},
    recentPartners: [],
    recentOpponents: [],
    benched: {},
    history: [],
    error: "",
    confirmState: {},
    confirmEndSession: false,
    scoreDraft: {},
    nameInput: "",
    lockedPairs: [],
    pendingLockId: null,
    lastFinish: null,
    bulkAddOpen: false,
    bulkAddText: "",
  };

  /* ---------- toast notification ---------- */
  var toastRoot = null;
  var toastTimer = null;

  function showToast(message, iconFn) {
    if (!toastRoot) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    var el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = (iconFn ? iconFn(14) : "") + "<span>" + escapeHtml(message) + "</span>";
    toastRoot.innerHTML = "";
    toastRoot.appendChild(el);
    // force reflow so the transition to toast-visible actually animates
    void el.offsetWidth;
    el.classList.add("toast-visible");
    toastTimer = setTimeout(function () {
      el.classList.remove("toast-visible");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 200);
    }, 2600);
  }

  function showUndoToast(message, onUndo) {
    if (!toastRoot) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    var el = document.createElement("div");
    el.className = "toast toast-undo";
    el.innerHTML =
      "<span>" + escapeHtml(message) + "</span>" +
      '<button type="button" class="toast-undo-btn">Undo</button>';
    toastRoot.innerHTML = "";
    toastRoot.appendChild(el);
    void el.offsetWidth;
    el.classList.add("toast-visible");

    var done = false;
    function hide() {
      if (done) return;
      done = true;
      el.classList.remove("toast-visible");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 200);
    }
    el.querySelector(".toast-undo-btn").addEventListener("click", function () {
      hide();
      onUndo();
    });
    toastTimer = setTimeout(hide, 10000);
  }

  /* ---------- helpers ---------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function pairKey(a, b) {
    return [a, b].sort().join("::");
  }

  function crossPairKeys(teamA, teamB) {
    return [
      pairKey(teamA[0].id, teamB[0].id),
      pairKey(teamA[0].id, teamB[1].id),
      pairKey(teamA[1].id, teamB[0].id),
      pairKey(teamA[1].id, teamB[1].id),
    ];
  }

  var RECENT_LIMIT = 6; // last 3 matches' worth of partner pairs
  var RECENT_OPP_LIMIT = 12; // last 3 matches' worth of opponent cross-pairs

  function splitScore(teamA, teamB, ph, oh, recent, recentOpp) {
    var k1 = pairKey(teamA[0].id, teamA[1].id);
    var k2 = pairKey(teamB[0].id, teamB[1].id);
    var partnerScore = (ph[k1] || 0) + (ph[k2] || 0);
    var crossKeys = crossPairKeys(teamA, teamB);
    var opponentScore = 0;
    if (oh) {
      crossKeys.forEach(function (k) {
        opponentScore += oh[k] || 0;
      });
    }
    // A pair that partnered in one of the last few matches gets a heavy
    // penalty on top of their lifetime count — this stops the same two
    // people from being reunited back-to-back (or almost back-to-back)
    // just because their overall repeat count still ties for lowest.
    var recentPenalty = 0;
    if (recent) {
      if (recent.indexOf(k1) !== -1) recentPenalty += 50;
      if (recent.indexOf(k2) !== -1) recentPenalty += 50;
    }
    // Same idea for opponents: facing the same person again a match or
    // two later gets a penalty even if their lifetime opponent count
    // still ties for lowest.
    if (recentOpp) {
      crossKeys.forEach(function (k) {
        if (recentOpp.indexOf(k) !== -1) recentPenalty += 20;
      });
    }
    // Skill balance: prefer splits where each team's combined skill is
    // close, so a team of two 5s doesn't face two total beginners.
    var skillA = (teamA[0].skill || 0) + (teamA[1].skill || 0);
    var skillB = (teamB[0].skill || 0) + (teamB[1].skill || 0);
    var skillPenalty = Math.abs(skillA - skillB) * 3;
    // Repeating a partner matters far more than repeating an opponent —
    // with a big player pool, facing someone across the net again and
    // again is the more visible/annoying repeat, so it still counts,
    // just less than an outright repeat partnership.
    return partnerScore * 4 + opponentScore + recentPenalty + skillPenalty;
  }

  function bestTeamSplit(four, partnerHistory, opponentHistory, recent, recentOpp) {
    var p0 = four[0], p1 = four[1], p2 = four[2], p3 = four[3];
    var options = shuffle([
      { teamA: [p0, p1], teamB: [p2, p3] },
      { teamA: [p0, p2], teamB: [p1, p3] },
      { teamA: [p0, p3], teamB: [p1, p2] },
    ]);
    var best = options[0];
    var bestScore = Infinity;
    options.forEach(function (opt) {
      var s = splitScore(opt.teamA, opt.teamB, partnerHistory, opponentHistory, recent, recentOpp);
      if (s < bestScore) {
        bestScore = s;
        best = opt;
      }
    });
    // randomize which side of the winning split is "Team A" vs "Team B"
    return Math.random() < 0.5 ? best : { teamA: best.teamB, teamB: best.teamA };
  }

  function occupiedIds(courtsArr) {
    var s = {};
    courtsArr.forEach(function (c) {
      if (!c) return;
      c.teamA.concat(c.teamB).forEach(function (p) {
        s[p.id] = true;
      });
    });
    return s;
  }

  function combosOf(arr, k) {
    var result = [];
    function helper(start, combo) {
      if (combo.length === k) {
        result.push(combo.slice());
        return;
      }
      for (var i = start; i < arr.length; i++) {
        combo.push(arr[i]);
        helper(i + 1, combo);
        combo.pop();
      }
    }
    helper(0, []);
    return result;
  }

  function bestSplitScore(four, ph, oh, recent, recentOpp) {
    var p0 = four[0], p1 = four[1], p2 = four[2], p3 = four[3];
    var options = [
      [[p0, p1], [p2, p3]],
      [[p0, p2], [p1, p3]],
      [[p0, p3], [p1, p2]],
    ];
    var best = Infinity;
    options.forEach(function (opt) {
      var s = splitScore(opt[0], opt[1], ph, oh, recent, recentOpp);
      if (s < best) best = s;
    });
    return best;
  }

  function pickFour(waitingPool, gp, bo, ph, oh, recent, recentOpp) {
    var sorted = shuffle(waitingPool).sort(function (a, b) {
      var diff = (gp[a.id] || 0) - (gp[b.id] || 0);
      if (diff !== 0) return diff;
      return (bo[a.id] || 0) - (bo[b.id] || 0);
    });

    if (sorted.length <= 4 || !ph) return sorted.slice(0, 4);

    // Players with strictly fewer games played are owed a spot and stay
    // locked in. Among players tied on games played for the remaining
    // slots, prefer whichever combination can be split into teams with
    // the fewest repeated partnerships (and, secondarily, the fewest
    // repeated opponents) — a group isn't penalized just because two of
    // them faced each other as opponents once before.
    var cutoffGp = gp[sorted[3].id] || 0;
    var locked = sorted.filter(function (p) { return (gp[p.id] || 0) < cutoffGp; });
    var tied = sorted.filter(function (p) { return (gp[p.id] || 0) === cutoffGp; });
    var slotsLeft = 4 - locked.length;

    if (tied.length <= slotsLeft) return locked.concat(tied).slice(0, 4);

    var candidates = tied.slice(0, 16); // bound the combination search
    var bestCombo = candidates.slice(0, slotsLeft);
    var bestScore = Infinity;
    combosOf(candidates, slotsLeft).forEach(function (combo) {
      var score = bestSplitScore(locked.concat(combo), ph, oh, recent, recentOpp);
      if (score < bestScore) {
        bestScore = score;
        bestCombo = combo;
      }
    });
    return locked.concat(bestCombo);
  }

  function buildUnits(playerList) {
    var byId = {};
    playerList.forEach(function (p) { byId[p.id] = p; });
    var used = {};
    var units = [];
    state.lockedPairs.forEach(function (pair) {
      var a = byId[pair.a], b = byId[pair.b];
      if (a && b && !used[a.id] && !used[b.id]) {
        units.push({ members: [a, b], isLocked: true });
        used[a.id] = true;
        used[b.id] = true;
      }
    });
    playerList.forEach(function (p) {
      if (!used[p.id]) units.push({ members: [p], isLocked: false });
    });
    return units;
  }

  function allSubsets(arr) {
    var result = [[]];
    arr.forEach(function (item) {
      var extended = result.map(function (s) { return s.concat([item]); });
      result = result.concat(extended);
    });
    return result;
  }

  // How many times these units' members have already faced each other as
  // opponents, lifetime — this is the thing that must never repeat if it
  // can possibly be helped, since a locked pair's partner never changes,
  // so the opponent is the only thing that can vary for them at all.
  function unitFoeRepeatScore(units, oh) {
    var score = 0;
    for (var i = 0; i < units.length; i++) {
      for (var j = i + 1; j < units.length; j++) {
        units[i].members.forEach(function (m1) {
          units[j].members.forEach(function (m2) {
            score += (oh && oh[pairKey(m1.id, m2.id)]) || 0;
          });
        });
      }
    }
    return score;
  }

  function unitRecentFoeHits(units, recentOpp) {
    if (!recentOpp) return 0;
    var hits = 0;
    for (var i = 0; i < units.length; i++) {
      for (var j = i + 1; j < units.length; j++) {
        units[i].members.forEach(function (m1) {
          units[j].members.forEach(function (m2) {
            if (recentOpp.indexOf(pairKey(m1.id, m2.id)) !== -1) hits++;
          });
        });
      }
    }
    return hits;
  }

  function pickUnitsForFour(waitingPool, gp, bo, ph, oh, recentOpp) {
    var units = buildUnits(waitingPool);
    if (units.length === 0) return null;

    var sorted = shuffle(units).sort(function (u1, u2) {
      var g1 = Math.max.apply(null, u1.members.map(function (m) { return gp[m.id] || 0; }));
      var g2 = Math.max.apply(null, u2.members.map(function (m) { return gp[m.id] || 0; }));
      if (g1 !== g2) return g1 - g2;
      var b1 = Math.max.apply(null, u1.members.map(function (m) { return bo[m.id] || 0; }));
      var b2 = Math.max.apply(null, u2.members.map(function (m) { return bo[m.id] || 0; }));
      return b1 - b2;
    });

    // Search combinations of units (bounded to the fairest candidates)
    // whose total size is exactly 4. A locked pair's partner is fixed,
    // so the opponent is the only thing that can vary for them — that
    // makes "never repeat the foe" the top priority here, well above
    // rotation fairness: we minimize lifetime foe-repeats first, then
    // break ties by fairness (games played), then by how recently that
    // foe was faced.
    var candidates = sorted.slice(0, 10);
    var subsets = allSubsets(candidates).filter(function (s) {
      var total = s.reduce(function (sum, u) { return sum + u.members.length; }, 0);
      return total === 4;
    });
    if (subsets.length === 0) return null;

    var best = null;
    var bestScore = Infinity;
    subsets.forEach(function (s) {
      var fairnessSum = 0;
      s.forEach(function (u) {
        u.members.forEach(function (m) { fairnessSum += gp[m.id] || 0; });
      });
      var foeRepeats = unitFoeRepeatScore(s, oh);
      var recentHits = unitRecentFoeHits(s, recentOpp);
      var score = foeRepeats * 1000000 + fairnessSum * 100 + recentHits;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    });
    return best;
  }

  // Picks the next four players and splits them into teams, honoring any
  // locked partnerships (they're always kept on the same team, overriding
  // the usual partner/opponent/skill scoring for that team).
  function resolveMatch(waitingPool, gp, bo, ph, oh, recent, recentOpp) {
    if (state.lockedPairs.length > 0) {
      var units = pickUnitsForFour(waitingPool, gp, bo, ph, oh, recentOpp);
      if (units) {
        var four = [];
        units.forEach(function (u) { four = four.concat(u.members); });
        var lockedUnits = units.filter(function (u) { return u.isLocked; });
        if (lockedUnits.length > 0) {
          var teamA, teamB;
          if (lockedUnits.length === 2) {
            teamA = lockedUnits[0].members;
            teamB = lockedUnits[1].members;
          } else {
            teamA = lockedUnits[0].members;
            teamB = [];
            units.forEach(function (u) {
              if (!u.isLocked) teamB = teamB.concat(u.members);
            });
          }
          var split = Math.random() < 0.5
            ? { teamA: teamA, teamB: teamB }
            : { teamA: teamB, teamB: teamA };
          return { four: four, split: split };
        }
        return { four: four, split: bestTeamSplit(four, ph, oh, recent, recentOpp) };
      }
      // couldn't fill exactly 4 respecting unit boundaries this round —
      // fall back to plain selection rather than blocking the court
    }
    var four = pickFour(waitingPool, gp, bo, ph, oh, recent, recentOpp);
    return { four: four, split: bestTeamSplit(four, ph, oh, recent, recentOpp) };
  }

  /* ---------- actions ---------- */
  function addPlayer() {
    var name = (state.nameInput || "").trim();
    if (!name) return;
    var exists = state.players.some(function (p) {
      return p.name.toLowerCase() === name.toLowerCase();
    });
    if (exists) {
      state.error = "That player's already on the list.";
      render();
      return;
    }
    var id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    state.players.push({ id: id, name: name, skill: 0, rating: STARTING_RATING });
    state.gamesPlayed[id] = 0;
    state.benchOrder[id] = -1;
    state.nameInput = "";
    state.error = "";
    render();
  }

  function toggleBulkAdd() {
    state.bulkAddOpen = !state.bulkAddOpen;
    if (!state.bulkAddOpen) state.bulkAddText = "";
    render();
  }

  function importBulkPlayers() {
    var raw = state.bulkAddText || "";
    var names = raw
      .split(/[\n,]+/)
      .map(function (s) { return s.replace(/^\s*\d+[.)]\s*/, "").trim(); })
      .filter(function (s) { return s.length > 0; });

    var existingLower = {};
    state.players.forEach(function (p) { existingLower[p.name.toLowerCase()] = true; });

    var added = 0, skipped = 0;
    names.forEach(function (name) {
      var lower = name.toLowerCase();
      if (existingLower[lower]) {
        skipped++;
        return;
      }
      existingLower[lower] = true;
      var id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      state.players.push({ id: id, name: name, skill: 0, rating: STARTING_RATING });
      state.gamesPlayed[id] = 0;
      state.benchOrder[id] = -1;
      added++;
    });

    state.bulkAddText = "";
    state.bulkAddOpen = false;
    state.error = "";
    render();

    if (added > 0) {
      var msg = added + " player" + (added === 1 ? "" : "s") + " added" +
        (skipped > 0 ? " (" + skipped + " duplicate" + (skipped === 1 ? "" : "s") + " skipped)" : "");
      showToast(msg, ICONS.check);
    } else {
      showToast(skipped > 0 ? "Already on the list" : "No names found", ICONS.x);
    }
  }

  function findLockPartnerId(id) {
    var pair = state.lockedPairs.filter(function (p) { return p.a === id || p.b === id; })[0];
    if (!pair) return null;
    return pair.a === id ? pair.b : pair.a;
  }

  function toggleLock(id) {
    var partnerId = findLockPartnerId(id);
    if (partnerId) {
      // already locked -- unlock
      state.lockedPairs = state.lockedPairs.filter(function (p) {
        return p.a !== id && p.b !== id;
      });
      if (state.pendingLockId === id) state.pendingLockId = null;
    } else if (state.pendingLockId === id) {
      // tapped the same player again -- cancel selection
      state.pendingLockId = null;
    } else if (state.pendingLockId === null) {
      // start selecting a partner for this player
      state.pendingLockId = id;
    } else {
      // completing a lock with the pending player (guaranteed unlocked, see above)
      state.lockedPairs.push({ a: state.pendingLockId, b: id });
      state.pendingLockId = null;
    }
    render();
  }

  function cycleSkill(id) {
    var p = state.players.filter(function (pl) { return pl.id === id; })[0];
    if (!p) return;
    p.skill = ((p.skill || 0) + 1) % 6;
    render();
  }

  function removePlayer(id) {
    state.players = state.players.filter(function (p) {
      return p.id !== id;
    });
    state.lockedPairs = state.lockedPairs.filter(function (pair) {
      return pair.a !== id && pair.b !== id;
    });
    if (state.pendingLockId === id) state.pendingLockId = null;
    render();
  }

  function startSession() {
    if (state.players.length < 4) {
      state.error = "Need at least 4 players.";
      render();
      return;
    }
    state.error = "";

    var gp = Object.assign({}, state.gamesPlayed);
    var bo = Object.assign({}, state.benchOrder);
    var ph = Object.assign({}, state.partnerHistory);
    var oh = Object.assign({}, state.opponentHistory);
    var recent = state.recentPartners.slice();
    var recentOpp = state.recentOpponents.slice();

    var waiting = state.players.filter(function (p) { return !state.benched[p.id]; });
    var newCourts = [];
    var newMatchCounts = [];

    for (var i = 0; i < state.numCourts; i++) {
      if (waiting.length < 4) {
        newCourts.push(null);
        newMatchCounts.push(0);
        continue;
      }
      var result = resolveMatch(waiting, gp, bo, ph, oh, recent, recentOpp);
      var four = result.four;
      var split = result.split;
      four.forEach(function (p) {
        gp[p.id] = (gp[p.id] || 0) + 1;
      });
      var kA = pairKey(split.teamA[0].id, split.teamA[1].id);
      var kB = pairKey(split.teamB[0].id, split.teamB[1].id);
      ph[kA] = (ph[kA] || 0) + 1;
      ph[kB] = (ph[kB] || 0) + 1;
      recent.unshift(kA, kB);
      recent = recent.slice(0, RECENT_LIMIT);
      var crossKeys = crossPairKeys(split.teamA, split.teamB);
      crossKeys.forEach(function (k) {
        oh[k] = (oh[k] || 0) + 1;
      });
      recentOpp = crossKeys.concat(recentOpp).slice(0, RECENT_OPP_LIMIT);
      var fourIds = four.map(function (f) { return f.id; });
      waiting = waiting.filter(function (p) {
        return fourIds.indexOf(p.id) === -1;
      });
      newCourts.push({ teamA: split.teamA, teamB: split.teamB });
      newMatchCounts.push(1);
    }

    state.gamesPlayed = gp;
    state.partnerHistory = ph;
    state.opponentHistory = oh;
    state.recentPartners = recent;
    state.recentOpponents = recentOpp;
    state.courts = newCourts;
    state.matchCounts = newMatchCounts;
    state.history = [];
    state.sessionStarted = true;
    render();
    showToast("Session started", ICONS.check);
  }

  function askFinishCourt(ci) {
    state.confirmState[ci] = "confirmFinish";
    render();
  }

  function cancelFinishCourt(ci) {
    delete state.confirmState[ci];
    delete state.scoreDraft[ci];
    state.error = "";
    render();
  }

  function proceedToScore(ci) {
    state.scoreDraft[ci] = { a: "", b: "" };
    state.confirmState[ci] = "recordScore";
    render();
  }

  function saveScoreAndFinish(ci) {
    var finished = state.courts[ci];
    if (!finished) return;
    var draft = state.scoreDraft[ci] || { a: "", b: "" };
    var scoreA = parseInt(draft.a, 10);
    var scoreB = parseInt(draft.b, 10);
    if (isNaN(scoreA) || isNaN(scoreB)) {
      state.error = "Enter a score for both teams.";
      render();
      return;
    }
    if (scoreA === scoreB) {
      state.error = "Scores can't be tied — pick a winner.";
      render();
      return;
    }

    var ratingSnapshot = {};
    finished.teamA.concat(finished.teamB).forEach(function (p) {
      ratingSnapshot[p.id] = p.rating !== undefined ? p.rating : STARTING_RATING;
    });

    state.lastFinish = {
      ci: ci,
      court: finished,
      benchOrder: Object.assign({}, state.benchOrder),
      turnCounter: state.turnCounter,
      ratingSnapshot: ratingSnapshot,
    };

    var counter = state.turnCounter;
    finished.teamA.concat(finished.teamB).forEach(function (p) {
      state.benchOrder[p.id] = counter;
    });
    counter += 1;

    var delta = ratingDelta(scoreA, scoreB);
    var winningTeam = scoreA > scoreB ? finished.teamA : finished.teamB;
    var losingTeam = scoreA > scoreB ? finished.teamB : finished.teamA;
    winningTeam.forEach(function (p) {
      p.rating = round2((p.rating !== undefined ? p.rating : STARTING_RATING) + delta);
    });
    losingTeam.forEach(function (p) {
      p.rating = round2((p.rating !== undefined ? p.rating : STARTING_RATING) - delta);
    });

    state.history.unshift({
      court: ci,
      matchNum: state.matchCounts[ci],
      teamA: finished.teamA,
      teamB: finished.teamB,
      scoreA: scoreA,
      scoreB: scoreB,
      winner: scoreA > scoreB ? "A" : "B",
    });

    state.courts[ci] = null;
    state.turnCounter = counter;
    state.error = "";
    delete state.scoreDraft[ci];
    state.confirmState[ci] = "confirmNext";
    render();
    showUndoToast("Match recorded", function () { undoLastFinish(ci); });
  }

  function undoLastFinish(ci) {
    var lf = state.lastFinish;
    if (!lf || lf.ci !== ci) return;
    state.courts[lf.ci] = lf.court;
    state.history.shift();
    state.benchOrder = lf.benchOrder;
    state.turnCounter = lf.turnCounter;
    if (lf.ratingSnapshot) {
      Object.keys(lf.ratingSnapshot).forEach(function (id) {
        var p = state.players.filter(function (pl) { return pl.id === id; })[0];
        if (p) p.rating = lf.ratingSnapshot[id];
      });
    }
    delete state.confirmState[lf.ci];
    state.lastFinish = null;
    render();
  }

  function generateNextForCourt(ci) {
    var occupied = occupiedIds(state.courts);
    var waiting = state.players.filter(function (p) {
      return !occupied[p.id] && !state.benched[p.id];
    });

    if (waiting.length < 4) {
      state.error =
        "Court " + (ci + 1) + " is waiting on players — only " + waiting.length + " free right now.";
      render();
      return;
    }

    if (state.lastFinish && state.lastFinish.ci === ci) state.lastFinish = null;

    var gp = Object.assign({}, state.gamesPlayed);
    var ph = Object.assign({}, state.partnerHistory);
    var oh = Object.assign({}, state.opponentHistory);
    var recent = state.recentPartners.slice();
    var recentOpp = state.recentOpponents.slice();

    var result = resolveMatch(waiting, gp, state.benchOrder, ph, oh, recent, recentOpp);
    var four = result.four;
    var split = result.split;
    four.forEach(function (p) {
      gp[p.id] = (gp[p.id] || 0) + 1;
    });
    var kA = pairKey(split.teamA[0].id, split.teamA[1].id);
    var kB = pairKey(split.teamB[0].id, split.teamB[1].id);
    ph[kA] = (ph[kA] || 0) + 1;
    ph[kB] = (ph[kB] || 0) + 1;
    recent.unshift(kA, kB);
    recent = recent.slice(0, RECENT_LIMIT);
    var crossKeys = crossPairKeys(split.teamA, split.teamB);
    crossKeys.forEach(function (k) {
      oh[k] = (oh[k] || 0) + 1;
    });
    recentOpp = crossKeys.concat(recentOpp).slice(0, RECENT_OPP_LIMIT);

    state.courts[ci] = { teamA: split.teamA, teamB: split.teamB };
    state.matchCounts[ci] = (state.matchCounts[ci] || 0) + 1;
    state.gamesPlayed = gp;
    state.partnerHistory = ph;
    state.opponentHistory = oh;
    state.recentPartners = recent;
    state.recentOpponents = recentOpp;
    state.error = "";
    delete state.confirmState[ci];
    render();
  }

  function toggleBench(id) {
    if (state.benched[id]) {
      delete state.benched[id];
    } else {
      state.benched[id] = true;
    }
    render();
  }

  function askReroll(ci) {
    state.confirmState[ci] = "confirmReroll";
    render();
  }

  function rerollCourt(ci) {
    var court = state.courts[ci];
    if (!court) return;
    var four = court.teamA.concat(court.teamB);
    var gp = Object.assign({}, state.gamesPlayed);
    var ph = Object.assign({}, state.partnerHistory);
    var oh = Object.assign({}, state.opponentHistory);
    four.forEach(function (p) {
      gp[p.id] = Math.max(0, (gp[p.id] || 0) - 1);
    });
    var kA = pairKey(court.teamA[0].id, court.teamA[1].id);
    var kB = pairKey(court.teamB[0].id, court.teamB[1].id);
    ph[kA] = Math.max(0, (ph[kA] || 0) - 1);
    ph[kB] = Math.max(0, (ph[kB] || 0) - 1);
    var crossKeys = crossPairKeys(court.teamA, court.teamB);
    crossKeys.forEach(function (k) {
      oh[k] = Math.max(0, (oh[k] || 0) - 1);
    });
    var recent = state.recentPartners.slice();
    [kA, kB].forEach(function (k) {
      var idx = recent.indexOf(k);
      if (idx !== -1) recent.splice(idx, 1);
    });
    var recentOpp = state.recentOpponents.slice();
    crossKeys.forEach(function (k) {
      var idx = recentOpp.indexOf(k);
      if (idx !== -1) recentOpp.splice(idx, 1);
    });
    state.gamesPlayed = gp;
    state.partnerHistory = ph;
    state.opponentHistory = oh;
    state.recentPartners = recent;
    state.recentOpponents = recentOpp;
    state.matchCounts[ci] = Math.max(0, (state.matchCounts[ci] || 1) - 1);
    state.courts[ci] = null;
    delete state.confirmState[ci];
    generateNextForCourt(ci);
  }

  function askEndSession() {
    state.confirmEndSession = true;
    render();
  }

  function cancelEndSession() {
    state.confirmEndSession = false;
    render();
  }

  function resetAll() {
    state.sessionStarted = false;
    state.courts = [];
    state.matchCounts = [];
    state.history = [];
    var gp = {}, bo = {};
    state.players.forEach(function (p) {
      gp[p.id] = 0;
      bo[p.id] = -1;
    });
    state.gamesPlayed = gp;
    state.benchOrder = bo;
    state.turnCounter = 0;
    state.partnerHistory = {};
    state.opponentHistory = {};
    state.recentPartners = [];
    state.recentOpponents = [];
    state.benched = {};
    state.error = "";
    state.confirmState = {};
    state.confirmEndSession = false;
    state.scoreDraft = {};
    render();
  }

  /* ---------- icons (inline SVG strings) ---------- */
  function icon(inner, size, extraStyle) {
    size = size || 16;
    return (
      '<svg class="icon" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" style="' + (extraStyle || "") + '">' +
      inner + "</svg>"
    );
  }
  var ICONS = {
    plus: function (size, style) {
      return icon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', size, style);
    },
    x: function (size, style) {
      return icon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', size, style);
    },
    shuffle: function (size, style) {
      return icon(
        '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>' +
        '<polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
        size, style
      );
    },
    rotateCcw: function (size, style) {
      return icon(
        '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
        size, style
      );
    },
    users: function (size, style) {
      return icon(
        '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
        '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        size, style
      );
    },
    check: function (size, style) {
      return icon('<polyline points="20 6 9 17 4 12"/>', size, style);
    },
    clock: function (size, style) {
      return icon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', size, style);
    },
    trophy: function (size, style) {
      return icon(
        '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>' +
        '<path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>' +
        '<path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
        size, style
      );
    },
    download: function (size, style) {
      return icon(
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
        '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        size, style
      );
    },
    link: function (size, style) {
      return icon(
        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
        '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        size, style
      );
    },
    lock: function (size, style) {
      return icon(
        '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        size, style
      );
    },
  };

  /* ---------- rendering ---------- */
  function teamNames(team) {
    return team.map(function (p) { return escapeHtml(p.name); }).join(" &amp; ");
  }

  function buildHeader() {
    return (
      '<div class="app-header">' +
        '<svg width="56" height="56" viewBox="0 0 56 56" style="flex-shrink:0">' +
          '<rect x="2" y="2" width="52" height="52" rx="4" fill="' + COURT_COLOR + '" stroke="' + LINE_COLOR + '" stroke-width="2"/>' +
          '<line x1="28" y1="2" x2="28" y2="54" stroke="' + LINE_COLOR + '" stroke-width="2"/>' +
          '<line x1="14" y1="2" x2="14" y2="54" stroke="' + LINE_COLOR + '" stroke-width="1.4" opacity="0.7"/>' +
          '<line x1="42" y1="2" x2="42" y2="54" stroke="' + LINE_COLOR + '" stroke-width="1.4" opacity="0.7"/>' +
          '<circle cx="28" cy="28" r="4" fill="' + BALL_COLOR + '"/>' +
        '</svg>' +
        '<div>' +
          '<h1 class="app-title">Open Play Generator</h1>' +
          '<p class="app-subtitle">Created By draiyned.</p>' +
        '</div>' +
      '</div>'
    );
  }

  function buildSetupPanel(occupied) {
    var chips = state.players.map(function (p) {
      var occCls = occupied[p.id] ? " occupied" : "";
      var isBenched = !!state.benched[p.id];
      var benchedCls = isBenched ? " benched" : "";
      var action = state.sessionStarted ? "toggle-bench" : "remove-player";
      var label = state.sessionStarted
        ? (isBenched ? "Mark " + p.name + " active" : "Mark " + p.name + " left")
        : "Remove " + p.name;
      var removeIcon = state.sessionStarted && isBenched ? ICONS.check(12) : ICONS.x(12);

      var skill = p.skill || 0;
      var skillLabel = SKILL_LABELS[skill] || "—";
      var skillTitle = skill === 0 ? "Set skill level" : SKILL_NAMES[skill] + " — tap to change";

      var partnerId = findLockPartnerId(p.id);
      var partner = partnerId ? state.players.filter(function (pl) { return pl.id === partnerId; })[0] : null;
      var isPending = state.pendingLockId === p.id;
      var lockCls = partner ? " locked" : (isPending ? " lock-pending" : "");
      var lockIcon = partner ? ICONS.lock(12) : ICONS.link(12);
      var lockTitle = partner
        ? "Locked with " + partner.name + " — tap to unlock"
        : (isPending ? "Tap another player to lock partner" : "Lock partner");

      return (
        '<span class="chip' + occCls + benchedCls + lockCls + '">' +
          escapeHtml(p.name) +
          (isBenched ? ' <span class="chip-tag">left</span>' : '') +
          (partner ? ' <span class="chip-tag chip-tag-lock">w/ ' + escapeHtml(partner.name) + '</span>' : '') +
          '<button type="button" class="chip-skill" data-action="cycle-skill" data-id="' + p.id + '" title="' + escapeHtml(skillTitle) + '">' + skillLabel + '</button>' +
          '<button type="button" class="chip-lock" data-action="toggle-lock" data-id="' + p.id + '" title="' + escapeHtml(lockTitle) + '">' + lockIcon + '</button>' +
          '<button type="button" class="chip-remove" data-action="' + action + '" data-id="' + p.id + '" aria-label="' + escapeHtml(label) + '">' +
            removeIcon +
          '</button>' +
        '</span>'
      );
    }).join("");

    var pendingPlayer = state.pendingLockId
      ? state.players.filter(function (p) { return p.id === state.pendingLockId; })[0]
      : null;

    return (
      '<div class="panel">' +
        '<div class="panel-label-row">' +
          ICONS.users(16, "color:" + BALL_COLOR) +
          '<span class="label-caps">Players (' + state.players.length + ')</span>' +
        '</div>' +
        '<div class="add-player-row">' +
          '<input id="name-input" class="text-input" placeholder="Add a player name" value="' + escapeHtml(state.nameInput) + '" />' +
          '<button type="button" class="btn-add" data-action="add-player">' + ICONS.plus(16) + ' Add</button>' +
        '</div>' +
        (state.bulkAddOpen
          ? (
              '<div class="bulk-add-panel">' +
                '<textarea id="bulk-add-input" class="bulk-add-textarea" placeholder="Paste names, one per line (or comma-separated)&#10;e.g.&#10;Alex&#10;Sam&#10;Jordan">' + escapeHtml(state.bulkAddText) + '</textarea>' +
                '<div class="btn-row">' +
                  '<button type="button" class="btn-small" data-action="import-bulk">' + ICONS.plus(13) + ' Import players</button>' +
                  '<button type="button" class="btn-ghost-small" data-action="toggle-bulk-add">Cancel</button>' +
                '</div>' +
              '</div>'
            )
          : '<button type="button" class="bulk-add-link" data-action="toggle-bulk-add">' + ICONS.users(13) + ' Paste a list of names</button>'
        ) +
        (pendingPlayer
          ? '<div class="lock-hint">' + ICONS.link(13) + ' Tap another player\'s lock icon to pair with ' + escapeHtml(pendingPlayer.name) + '</div>'
          : "") +
        (state.players.length > 0 ? '<div class="player-chips">' + chips + '</div>' : "") +
        '<label class="courts-label">Courts' +
          '<input id="num-courts-input" type="number" min="1" max="20" value="' + state.numCourts + '" class="number-input"' + (state.sessionStarted ? " disabled" : "") + ' />' +
        '</label>' +
      '</div>'
    );
  }

  function buildErrorBanner() {
    if (!state.error) return "";
    return '<div class="error-banner">' + escapeHtml(state.error) + '</div>';
  }

  function buildActionsRow() {
    if (!state.sessionStarted) {
      return (
        '<div class="actions-row">' +
          '<button type="button" class="btn-primary" data-action="start-session">' + ICONS.shuffle(16) + ' Start Session</button>' +
        '</div>'
      );
    }
    if (state.confirmEndSession) {
      return (
        '<div class="actions-row confirm-block" style="width:100%">' +
          '<div class="confirm-text">End this session? Courts and match history will be cleared.</div>' +
          '<div class="btn-row">' +
            '<button type="button" class="btn-small" data-action="reset-all">' + ICONS.check(13) + ' Yes, end session</button>' +
            '<button type="button" class="btn-ghost-small" data-action="cancel-end-session">Cancel</button>' +
          '</div>' +
        '</div>'
      );
    }
    return (
      '<div class="actions-row">' +
        '<button type="button" class="btn-secondary" data-action="ask-end-session">' + ICONS.rotateCcw(14) + ' End session</button>' +
      '</div>'
    );
  }

  function buildCourtCard(court, ci, freeCount) {
    var activeCls = court ? " active" : "";
    var inner = "";

    if (court) {
      inner += '<div class="net-line"></div>';
      inner += (
        '<div class="court-head">' +
          '<span class="court-label">Court ' + (ci + 1) + '</span>' +
          '<span class="match-num">match ' + state.matchCounts[ci] + '</span>' +
        '</div>' +
        '<div class="team-name">' + teamNames(court.teamA) + '</div>' +
        '<div class="vs">vs</div>' +
        '<div class="team-name">' + teamNames(court.teamB) + '</div>'
      );

      var cs = state.confirmState[ci];
      if (cs === "confirmFinish") {
        inner += (
          '<div class="confirm-block">' +
            '<div class="confirm-text">Mark this match finished?</div>' +
            '<div class="btn-row">' +
              '<button type="button" class="btn-small" data-action="proceed-score" data-ci="' + ci + '">' + ICONS.check(13) + ' Yes, finished</button>' +
              '<button type="button" class="btn-ghost-small" data-action="cancel-finish" data-ci="' + ci + '">Cancel</button>' +
            '</div>' +
          '</div>'
        );
      } else if (cs === "recordScore") {
        var draft = state.scoreDraft[ci] || { a: "", b: "" };
        inner += (
          '<div class="confirm-block">' +
            '<div class="confirm-text">What was the score?</div>' +
            '<div class="score-row">' +
              '<label class="score-label"><span class="score-team-name">' + teamNames(court.teamA) + '</span>' +
                '<input type="number" min="0" class="score-input" data-bind="score" data-ci="' + ci + '" data-team="a" value="' + escapeHtml(draft.a) + '" />' +
              '</label>' +
            '</div>' +
            '<div class="score-row last">' +
              '<label class="score-label"><span class="score-team-name">' + teamNames(court.teamB) + '</span>' +
                '<input type="number" min="0" class="score-input" data-bind="score" data-ci="' + ci + '" data-team="b" value="' + escapeHtml(draft.b) + '" />' +
              '</label>' +
            '</div>' +
            '<div class="btn-row">' +
              '<button type="button" class="btn-small" data-action="save-score" data-ci="' + ci + '">' + ICONS.check(13) + ' Save match</button>' +
              '<button type="button" class="btn-ghost-small" data-action="cancel-finish" data-ci="' + ci + '">Cancel</button>' +
            '</div>' +
          '</div>'
        );
      } else if (cs === "confirmReroll") {
        inner += (
          '<div class="confirm-block">' +
            '<div class="confirm-text">Cancel this match and generate a new pairing?</div>' +
            '<div class="btn-row">' +
              '<button type="button" class="btn-small" data-action="reroll" data-ci="' + ci + '">' + ICONS.check(13) + ' Yes, reroll</button>' +
              '<button type="button" class="btn-ghost-small" data-action="cancel-finish" data-ci="' + ci + '">Cancel</button>' +
            '</div>' +
          '</div>'
        );
      } else {
        inner += (
          '<div class="btn-row">' +
            '<button type="button" class="btn-small" data-action="ask-finish" data-ci="' + ci + '">' +
              ICONS.check(13) + ' Finished — next match</button>' +
            '<button type="button" class="btn-ghost-small" data-action="ask-reroll" data-ci="' + ci + '" title="Cancel and re-pair this match">' +
              ICONS.shuffle(12) + ' Reroll</button>' +
          '</div>'
        );
      }
    } else if (freeCount >= 4) {
      inner += (
        '<div>' +
          '<div class="court-head"><span class="court-label">Court ' + (ci + 1) + '</span></div>' +
          '<div class="confirm-text">Ready for the next match.</div>' +
          '<button type="button" class="btn-small" data-action="generate-next" data-ci="' + ci + '">' +
            ICONS.shuffle(13) + ' Generate next match</button>' +
        '</div>'
      );
    } else {
      inner += (
        '<div class="court-head"><span class="court-label">Court ' + (ci + 1) + '</span></div>' +
        '<div class="court-idle">' + ICONS.clock(13) + ' Waiting for players</div>'
      );
    }

    return '<div class="court-card' + activeCls + '">' + inner + '</div>';
  }

  function buildCourtsGrid() {
    var occupied = occupiedIds(state.courts);
    var freeCount = state.players.filter(function (p) { return !occupied[p.id] && !state.benched[p.id]; }).length;
    return '<div class="courts-grid">' + state.courts.map(function (court, ci) {
      return buildCourtCard(court, ci, freeCount);
    }).join("") + '</div>';
  }

  function buildWaitingSection(occupied) {
    var waitingPlayers = state.players.filter(function (p) { return !occupied[p.id] && !state.benched[p.id]; });
    var list;
    if (waitingPlayers.length === 0) {
      list = '<span class="waiting-empty">Everyone\'s on a court.</span>';
    } else {
      list = waitingPlayers.map(function (p) {
        return '<span class="waiting-chip">' + escapeHtml(p.name) + '</span>';
      }).join("");
    }
    return (
      '<div class="waiting-section">' +
        '<div class="section-label">Waiting (' + waitingPlayers.length + ')</div>' +
        '<div class="waiting-list">' + list + '</div>' +
      '</div>'
    );
  }

  function computeStandings() {
    var stats = {};
    state.players.forEach(function (p) {
      stats[p.id] = {
        id: p.id, name: p.name, matches: 0, wins: 0, losses: 0, pf: 0, pa: 0,
        rating: p.rating !== undefined ? p.rating : STARTING_RATING,
      };
    });
    state.history.forEach(function (h) {
      var aWon = h.winner === "A";
      h.teamA.forEach(function (p) {
        var s = stats[p.id];
        if (!s) return;
        s.matches += 1;
        s.pf += h.scoreA;
        s.pa += h.scoreB;
        if (aWon) s.wins += 1; else s.losses += 1;
      });
      h.teamB.forEach(function (p) {
        var s = stats[p.id];
        if (!s) return;
        s.matches += 1;
        s.pf += h.scoreB;
        s.pa += h.scoreA;
        if (aWon) s.losses += 1; else s.wins += 1;
      });
    });
    var list = Object.keys(stats).map(function (id) { return stats[id]; });
    list.forEach(function (s) {
      s.diff = s.pf - s.pa;
      s.winRate = s.matches > 0 ? s.wins / s.matches : 0;
    });
    // Rank by wins, then win rate, then point differential, then name —
    // point differential is what keeps players with identical win/loss
    // records (e.g. a three-way tie) from rendering in an arbitrary order.
    list.sort(function (a, b) {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.diff !== a.diff) return b.diff - a.diff;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  function buildStandingsRow(s, rank) {
    var pct = Math.round(s.winRate * 100);
    var diffText = (s.diff > 0 ? "+" : "") + s.diff;
    var diffClass = s.diff > 0 ? "pos" : (s.diff < 0 ? "neg" : "");
    return (
      '<div class="standings-row">' +
        '<span class="standings-rank">' + rank + '</span>' +
        '<span class="standings-name">' + escapeHtml(s.name) + '</span>' +
        '<span class="standings-record">' + s.wins + '-' + s.losses + '</span>' +
        '<span class="standings-matches">' + s.matches + '</span>' +
        '<span class="standings-pct">' + pct + '%</span>' +
        '<span class="standings-diff ' + diffClass + '">' + diffText + '</span>' +
        '<span class="standings-rating">' + s.rating.toFixed(2) + '</span>' +
      '</div>'
    );
  }

  function buildStandingsSection() {
    if (state.history.length === 0) return "";
    var standings = computeStandings();
    return (
      '<div class="standings-section">' +
        '<div class="section-label">Standings</div>' +
        '<div class="standings-table">' +
          '<div class="standings-row standings-header">' +
            '<span class="standings-rank">#</span>' +
            '<span class="standings-name">Player</span>' +
            '<span class="standings-record">W-L</span>' +
            '<span class="standings-matches">MP</span>' +
            '<span class="standings-pct">Win%</span>' +
            '<span class="standings-diff">+/-</span>' +
            '<span class="standings-rating">Rating</span>' +
          '</div>' +
          standings.map(function (s, i) { return buildStandingsRow(s, i + 1); }).join("") +
        '</div>' +
      '</div>'
    );
  }

  function buildHistoryCard(h) {
    var winA = h.winner === "A";
    var winB = h.winner === "B";
    return (
      '<div class="history-card">' +
        '<div class="net-line"></div>' +
        '<div class="history-head">' +
          '<span class="history-court-label">Court ' + (h.court + 1) + '</span>' +
          '<span class="history-match-num">' + ICONS.check(11) + ' match ' + h.matchNum + '</span>' +
        '</div>' +
        '<div class="history-team-row' + (winA ? " winner" : "") + '">' +
          '<span class="history-team-name">' + (winA ? ICONS.trophy(12, "color:" + BALL_COLOR) : "") + teamNames(h.teamA) + '</span>' +
          '<span class="history-score">' + h.scoreA + '</span>' +
        '</div>' +
        '<div class="history-vs">vs</div>' +
        '<div class="history-team-row' + (winB ? " winner" : "") + '">' +
          '<span class="history-team-name">' + (winB ? ICONS.trophy(12, "color:" + BALL_COLOR) : "") + teamNames(h.teamB) + '</span>' +
          '<span class="history-score">' + h.scoreB + '</span>' +
        '</div>' +
      '</div>'
    );
  }

  function buildHistorySection() {
    if (state.history.length === 0) return "";
    return (
      '<div>' +
        '<div class="section-label" style="display:flex;align-items:center;justify-content:space-between">' +
          '<span>Completed matches</span>' +
          '<button type="button" class="btn-ghost-small" data-action="download-history">' + ICONS.download(12) + ' Download CSV</button>' +
        '</div>' +
        '<div class="history-grid">' + state.history.map(buildHistoryCard).join("") + '</div>' +
      '</div>'
    );
  }

  function csvEscape(val) {
    var s = String(val);
    if (/[",\n]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function downloadHistory() {
    if (state.history.length === 0) return;
    var rows = [["Court", "Match #", "Team A", "Team B", "Score A", "Score B", "Winner"]];
    // history is stored newest-first; export oldest-first so it reads top-to-bottom chronologically
    state.history.slice().reverse().forEach(function (h) {
      var winnerNames = h.winner === "A"
        ? h.teamA.map(function (p) { return p.name; }).join(" & ")
        : h.teamB.map(function (p) { return p.name; }).join(" & ");
      rows.push([
        h.court + 1,
        h.matchNum,
        h.teamA.map(function (p) { return p.name; }).join(" & "),
        h.teamB.map(function (p) { return p.name; }).join(" & "),
        h.scoreA,
        h.scoreB,
        winnerNames,
      ]);
    });
    var csv = rows.map(function (r) { return r.map(csvEscape).join(","); }).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = "match-history-" + stamp + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function buildHTML() {
    var occupied = occupiedIds(state.courts);
    var html = '<div class="container">';
    html += buildHeader();
    html += buildSetupPanel(occupied);
    html += buildErrorBanner();
    html += buildActionsRow();
    if (state.sessionStarted) {
      html += buildCourtsGrid();
      html += buildWaitingSection(occupied);
      html += buildStandingsSection();
      html += buildHistorySection();
    }
    html += '</div>';
    return html;
  }

  var root;
  var focusMemo = null; // remembers which input had focus + cursor position across re-renders

  function captureFocus() {
    var el = document.activeElement;
    if (el && root.contains(el) && (el.id === "name-input" || el.id === "num-courts-input" || el.dataset.bind === "score")) {
      focusMemo = {
        id: el.id || null,
        ci: el.dataset ? el.dataset.ci : null,
        team: el.dataset ? el.dataset.team : null,
        selectionStart: el.selectionStart,
        selectionEnd: el.selectionEnd,
      };
    } else {
      focusMemo = null;
    }
  }

  function restoreFocus() {
    if (!focusMemo) return;
    var el = null;
    if (focusMemo.id) {
      el = document.getElementById(focusMemo.id);
    } else if (focusMemo.ci !== null) {
      el = root.querySelector(
        '[data-bind="score"][data-ci="' + focusMemo.ci + '"][data-team="' + focusMemo.team + '"]'
      );
    }
    if (el) {
      el.focus();
      if (typeof focusMemo.selectionStart === "number" && el.setSelectionRange) {
        try {
          el.setSelectionRange(focusMemo.selectionStart, focusMemo.selectionEnd);
        } catch (e) {
          /* ignore inputs that don't support selection (e.g. type=number in some browsers) */
        }
      }
    }
  }

  /* ---------- persistence ---------- */
  var BASE_STORAGE_KEY = "open-play-generator-state-v1";
  var tabId = null;

  function getTabId() {
    if (tabId) return tabId;
    try {
      var hs = window.history.state;
      if (hs && hs.opgTabId) {
        tabId = hs.opgTabId;
      } else {
        tabId = "opg-tab-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
        var newState = Object.assign({}, hs || {}, { opgTabId: tabId });
        window.history.replaceState(newState, "");
      }
    } catch (e) {
      tabId = "opg-tab-fallback";
    }
    return tabId;
  }

  function storageKey() {
    return BASE_STORAGE_KEY + ":" + getTabId();
  }

  function saveState() {
    try {
      var toSave = {
        players: state.players,
        numCourts: state.numCourts,
        sessionStarted: state.sessionStarted,
        courts: state.courts,
        matchCounts: state.matchCounts,
        gamesPlayed: state.gamesPlayed,
        benchOrder: state.benchOrder,
        turnCounter: state.turnCounter,
        partnerHistory: state.partnerHistory,
        opponentHistory: state.opponentHistory,
        recentPartners: state.recentPartners,
        recentOpponents: state.recentOpponents,
        lockedPairs: state.lockedPairs,
        benched: state.benched,
        history: state.history,
      };
      sessionStorage.setItem(storageKey(), JSON.stringify(toSave));
    } catch (e) {
      // sessionStorage unavailable (private browsing, quota, etc.) — fail silently
    }
  }

  function loadState() {
    try {
      var raw = sessionStorage.getItem(storageKey());
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;
      Object.keys(saved).forEach(function (key) {
        state[key] = saved[key];
      });
    } catch (e) {
      // corrupted or inaccessible storage — start fresh
    }
  }

  function render() {
    captureFocus();
    root.innerHTML = buildHTML();
    restoreFocus();
    saveState();
  }

  /* ---------- event delegation ---------- */
  function handleClick(e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.dataset.action;
    var ci = btn.dataset.ci !== undefined ? Number(btn.dataset.ci) : undefined;
    if (action === "add-player") addPlayer();
    else if (action === "toggle-bulk-add") toggleBulkAdd();
    else if (action === "import-bulk") importBulkPlayers();
    else if (action === "remove-player") removePlayer(btn.dataset.id);
    else if (action === "toggle-bench") toggleBench(btn.dataset.id);
    else if (action === "cycle-skill") cycleSkill(btn.dataset.id);
    else if (action === "toggle-lock") toggleLock(btn.dataset.id);
    else if (action === "start-session") startSession();
    else if (action === "ask-end-session") askEndSession();
    else if (action === "cancel-end-session") cancelEndSession();
    else if (action === "reset-all") resetAll();
    else if (action === "ask-finish") askFinishCourt(ci);
    else if (action === "cancel-finish") cancelFinishCourt(ci);
    else if (action === "proceed-score") proceedToScore(ci);
    else if (action === "save-score") saveScoreAndFinish(ci);
    else if (action === "generate-next") generateNextForCourt(ci);
    else if (action === "ask-reroll") askReroll(ci);
    else if (action === "reroll") rerollCourt(ci);
    else if (action === "download-history") downloadHistory();
  }

  function handleInput(e) {
    var t = e.target;
    if (t.id === "name-input") {
      state.nameInput = t.value;
    } else if (t.id === "bulk-add-input") {
      state.bulkAddText = t.value;
    } else if (t.id === "num-courts-input") {
      state.numCourts = Math.max(1, parseInt(t.value, 10) || 1);
    } else if (t.dataset && t.dataset.bind === "score") {
      var ci = t.dataset.ci;
      var team = t.dataset.team;
      if (!state.scoreDraft[ci]) state.scoreDraft[ci] = { a: "", b: "" };
      state.scoreDraft[ci][team] = t.value;
    }
  }

  function handleKeydown(e) {
    if (e.target && e.target.id === "name-input" && e.key === "Enter") {
      e.preventDefault();
      addPlayer();
    }
  }

  function init() {
    root = document.getElementById("root");
    toastRoot = document.getElementById("toast-root");
    root.addEventListener("click", handleClick);
    root.addEventListener("input", handleInput);
    root.addEventListener("keydown", handleKeydown);
    loadState();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
