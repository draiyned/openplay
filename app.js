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
    courtTimers: [],
    retiredMs: 0,
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
    bulkAddOpen: false,
    bulkAddText: "",
    sessionStartedAt: null,
    live: null,
    liveOpen: false,
    restoreOffers: [],
    pastOpen: false,
    pastViewId: null,
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

  /* ---------- undo ---------- */
  // Every action that changes players, courts, matches or ratings snapshots
  // the relevant state first, so the Undo button can step back through them.
  var UNDO_FIELDS = [
    "players", "numCourts", "sessionStarted", "courts", "matchCounts",
    "gamesPlayed", "benchOrder", "turnCounter", "partnerHistory",
    "opponentHistory", "recentPartners", "recentOpponents", "lockedPairs",
    "benched", "history", "sessionStartedAt",
  ];
  var UNDO_LIMIT = 50;
  var undoStack = [];
  var undoSeq = 0;
  var MIN_COURTS = 1;
  var MAX_COURTS = 20;

  function snapshotState() {
    var o = {};
    UNDO_FIELDS.forEach(function (k) { o[k] = state[k]; });
    return JSON.parse(JSON.stringify(o));
  }

  function pushUndo(label, snap) {
    undoSeq += 1;
    undoStack.push({ id: undoSeq, label: label, snap: snap || snapshotState() });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    return undoSeq;
  }

  // Courts and history hold the same player objects as state.players (ratings
  // are updated in place). JSON round-trips break that sharing, so re-link by id.
  function relinkPlayers() {
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = p; });
    function fix(p) { return byId[p.id] || p; }
    state.courts = (state.courts || []).map(function (c) {
      return c ? { teamA: c.teamA.map(fix), teamB: c.teamB.map(fix) } : null;
    });
    (state.history || []).forEach(function (h) {
      h.teamA = h.teamA.map(fix);
      h.teamB = h.teamB.map(fix);
    });
  }

  function undo() {
    var entry = undoStack.pop();
    if (!entry) return;
    if (entry.archiveId) removeArchive(entry.archiveId);
    Object.keys(entry.snap).forEach(function (k) { state[k] = entry.snap[k]; });
    relinkPlayers();
    state.confirmState = {};
    state.scoreDraft = {};
    state.pendingLockId = null;
    state.confirmEndSession = false;
    state.error = "";
    render();
    showToast("Undid: " + entry.label, ICONS.rotateCcw);
  }

  function undoIfLatest(id) {
    var top = undoStack[undoStack.length - 1];
    if (top && top.id === id) undo();
  }

  /* ---------- court rental timers ---------- */
  // One timer per court, running from when the court joins the session.
  // Pausing (rain, breaks) stops the clock. Time from removed courts is kept
  // in retiredMs so the session total stays correct.
  function newTimer() { return { acc: 0, since: Date.now() }; }

  function timerMs(t) {
    return t ? t.acc + (t.since ? Date.now() - t.since : 0) : 0;
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function fmtDuration(ms) {
    var s = Math.floor(ms / 1000);
    return pad2(Math.floor(s / 3600)) + ":" + pad2(Math.floor((s % 3600) / 60)) + ":" + pad2(s % 60);
  }

  function totalCourtMs() {
    return (state.retiredMs || 0) + state.courtTimers.reduce(function (a, t) { return a + timerMs(t); }, 0);
  }

  function fmtCourtHours(ms) {
    return (ms / 3600000).toFixed(2) + " court-hrs";
  }

  // Keep timers lined up with courts after start, add/remove court, undo, reload.
  function reconcileTimers() {
    if (!state.sessionStarted) {
      state.courtTimers = [];
      state.retiredMs = 0;
      return;
    }
    if (!Array.isArray(state.courtTimers)) state.courtTimers = [];
    while (state.courtTimers.length < state.courts.length) state.courtTimers.push(newTimer());
    while (state.courtTimers.length > state.courts.length) {
      state.retiredMs = (state.retiredMs || 0) + timerMs(state.courtTimers.pop());
    }
  }

  function toggleCourtTimer(ci) {
    var t = state.courtTimers[ci];
    if (!t) return;
    if (t.since) {
      t.acc += Date.now() - t.since;
      t.since = null;
    } else {
      t.since = Date.now();
    }
    render();
  }

  function updateTimers() {
    if (!state.sessionStarted) return;
    var els = document.querySelectorAll("[data-court-timer]");
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = fmtDuration(timerMs(state.courtTimers[Number(els[i].getAttribute("data-court-timer"))]));
    }
    var total = totalCourtMs();
    var tEl = document.querySelector("[data-total-timer]");
    if (tEl) tEl.textContent = fmtDuration(total);
    var hEl = document.querySelector("[data-total-hours]");
    if (hEl) hEl.textContent = fmtCourtHours(total);
  }

  function buildCourtTimer(ci) {
    var t = state.courtTimers[ci];
    var paused = t && !t.since;
    return (
      '<div class="court-timer' + (paused ? " paused" : "") + '">' +
        ICONS.clock(13) +
        '<span class="timer-clock" data-court-timer="' + ci + '">' + fmtDuration(timerMs(t)) + '</span>' +
        '<button type="button" class="timer-btn" data-action="toggle-court-timer" data-ci="' + ci + '" ' +
          'aria-label="' + (paused ? "Resume court timer" : "Pause court timer") + '" ' +
          'title="' + (paused ? "Resume court timer" : "Pause court timer") + '">' +
          (paused ? ICONS.play(12) : ICONS.pause(12)) +
        '</button>' +
      '</div>'
    );
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
    pushUndo("Add " + name);
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

    var undoSnap = snapshotState();
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

    if (added > 0) pushUndo("Add " + added + " player" + (added === 1 ? "" : "s"), undoSnap);
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
      pushUndo("Unlock partners");
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
      pushUndo("Lock partners");
      state.lockedPairs.push({ a: state.pendingLockId, b: id });
      state.pendingLockId = null;
    }
    render();
  }

  function cycleSkill(id) {
    var p = state.players.filter(function (pl) { return pl.id === id; })[0];
    if (!p) return;
    pushUndo("Change skill: " + p.name);
    p.skill = ((p.skill || 0) + 1) % 6;
    render();
  }

  function removePlayer(id) {
    var rp = state.players.filter(function (p) { return p.id === id; })[0];
    if (!rp) return;
    pushUndo("Remove " + rp.name);
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
    pushUndo("Start session");

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
    state.sessionStartedAt = Date.now();
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

    var undoId = pushUndo("Finish match on court " + (ci + 1));

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
    showUndoToast("Match recorded", function () { undoIfLatest(undoId); });
  }

  function generateNextForCourt(ci, skipUndo) {
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

    if (!skipUndo) pushUndo("Generate match on court " + (ci + 1));

    var gp = Object.assign({}, state.gamesPlayed);
    var ph = Object.assign({}, state.partnerHistory);
    var oh = Object.assign({}, state.opponentHistory);
    var recent = state.recentPartners.slice();
    var recentOpp = state.recentOpponents.slice();

    var result = (skipUndo ? null : takePreview(waiting)) ||
      resolveMatch(waiting, gp, state.benchOrder, ph, oh, recent, recentOpp);
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
    var bp = state.players.filter(function (p) { return p.id === id; })[0];
    pushUndo((state.benched[id] ? "Mark active: " : "Mark left: ") + (bp ? bp.name : ""));
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
    pushUndo("Reroll court " + (ci + 1));
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
    generateNextForCourt(ci, true);
  }

  function changeCourts(delta) {
    var next = state.numCourts + delta;
    if (next < MIN_COURTS || next > MAX_COURTS) return;

    if (state.sessionStarted && delta < 0) {
      var last = state.courts.length - 1;
      if (state.courts[last]) {
        state.error = "Court " + (last + 1) + " has a match in progress — finish or reroll it before removing the court.";
        render();
        return;
      }
    }

    pushUndo(delta > 0 ? "Add court" : "Remove court");
    state.numCourts = next;
    if (state.sessionStarted) {
      if (delta > 0) {
        state.courts.push(null);
        state.matchCounts.push(0);
      } else {
        var removed = state.courts.length - 1;
        state.courts.pop();
        state.matchCounts.pop();
        delete state.confirmState[removed];
        delete state.scoreDraft[removed];
      }
    }
    state.error = "";
    render();
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
    pushUndo("End session");
    var archivedId = archiveSession();
    if (archivedId) undoStack[undoStack.length - 1].archiveId = archivedId;
    if (state.live) pushLive(true, buildLiveSnapshot(true));
    state.sessionStartedAt = null;
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
    if (archivedId) showToast("Session saved to Past sessions", ICONS.check);
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
    share: function (size, style) {
      return icon('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>', size, style);
    },
    play: function (size, style) {
      return icon('<polygon points="6 4 20 12 6 20 6 4"/>', size, style);
    },
    pause: function (size, style) {
      return icon('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', size, style);
    },
    minus: function (size, style) {
      return icon('<line x1="5" y1="12" x2="19" y2="12"/>', size, style);
    },
    undo: function (size, style) {
      return icon('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>', size, style);
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
        '<div class="courts-label">Courts' +
          '<div class="courts-stepper">' +
            '<button type="button" class="stepper-btn" data-action="courts-dec" aria-label="Remove a court"' + (state.numCourts <= MIN_COURTS ? " disabled" : "") + '>' + ICONS.minus(14) + '</button>' +
            '<span class="stepper-value" aria-live="polite">' + state.numCourts + '</span>' +
            '<button type="button" class="stepper-btn" data-action="courts-inc" aria-label="Add a court"' + (state.numCourts >= MAX_COURTS ? " disabled" : "") + '>' + ICONS.plus(14) + '</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function buildErrorBanner() {
    if (!state.error) return "";
    return '<div class="error-banner">' + escapeHtml(state.error) + '</div>';
  }

  function buildUndoButton() {
    var top = undoStack.length ? undoStack[undoStack.length - 1] : null;
    return (
      '<button type="button" class="btn-secondary btn-undo" data-action="undo"' + (top ? "" : " disabled") +
      ' title="' + (top ? escapeHtml("Undo: " + top.label) : "Nothing to undo") + '">' +
        ICONS.undo(14) + ' Undo' +
        (top ? '<span class="undo-label">' + escapeHtml(top.label) + '</span>' : "") +
      '</button>'
    );
  }

  function buildActionsRow() {
    if (!state.sessionStarted) {
      return (
        '<div class="actions-row">' +
          '<button type="button" class="btn-primary" data-action="start-session">' + ICONS.shuffle(16) + ' Start Session</button>' +
          buildUndoButton() +
        '</div>'
      );
    }
    if (state.confirmEndSession) {
      return (
        '<div class="actions-row confirm-block" style="width:100%">' +
          '<div class="confirm-text">End this session? The leaderboard and matches are saved under Past sessions, then courts are cleared.</div>' +
          '<div class="btn-row">' +
            '<button type="button" class="btn-small" data-action="reset-all">' + ICONS.check(13) + ' Yes, end session</button>' +
            '<button type="button" class="btn-ghost-small" data-action="cancel-end-session">Cancel</button>' +
          '</div>' +
        '</div>'
      );
    }
    return (
      '<div class="actions-row">' +
        buildUndoButton() +
        '<button type="button" class="btn-secondary" data-action="toggle-live-panel">' + ICONS.share(14) + ' Share live</button>' +
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
        buildCourtTimer(ci) +
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
          buildCourtTimer(ci) +
          '<div class="confirm-text">Ready for the next match.</div>' +
          '<button type="button" class="btn-small" data-action="generate-next" data-ci="' + ci + '">' +
            ICONS.shuffle(13) + ' Generate next match</button>' +
        '</div>'
      );
    } else {
      inner += (
        '<div class="court-head"><span class="court-label">Court ' + (ci + 1) + '</span></div>' +
        buildCourtTimer(ci) +
        '<div class="court-idle">' + ICONS.clock(13) + ' Waiting for players</div>'
      );
    }

    return '<div class="court-card' + activeCls + '">' + inner + '</div>';
  }

  function buildCourtsGrid() {
    var occupied = occupiedIds(state.courts);
    var freeCount = state.players.filter(function (p) { return !occupied[p.id] && !state.benched[p.id]; }).length;
    var total = totalCourtMs();
    var summary = (
      '<div class="court-time-summary">' +
        '<span>Rented court time</span>' +
        '<b data-total-timer>' + fmtDuration(total) + '</b>' +
        '<span class="muted" data-total-hours>' + fmtCourtHours(total) + '</span>' +
      '</div>'
    );
    return summary + '<div class="courts-grid">' + state.courts.map(function (court, ci) {
      return buildCourtCard(court, ci, freeCount);
    }).join("") + '</div>';
  }

  function buildWaitingSection(occupied) {
    var waitingPlayers = queueOrder();
    updatePreview();
    var first = previewCache && previewCache.matches[0];
    var nextIds = {};
    if (first) first.teamA.concat(first.teamB).forEach(function (id) { nextIds[id] = 1; });
    var nextLine = "";
    if (previewCache && previewCache.matches.length) {
      nextLine = '<div class="next-line">' + previewCache.matches.map(function (m, i) {
        var n = previewNames(m);
        return '<div><b>' + (i === 0 ? "NEXT" : "then") + ':</b> ' + escapeHtml(n.a.join(" & ")) + ' <span class="vs">vs</span> ' + escapeHtml(n.b.join(" & ")) + '</div>';
      }).join("") + '</div>';
    }
    var list;
    if (waitingPlayers.length === 0) {
      list = '<span class="waiting-empty">Everyone\'s on a court.</span>';
    } else {
      list = waitingPlayers.map(function (p) {
        return '<span class="waiting-chip' + (nextIds[p.id] ? ' next-chip' : '') + '">' + escapeHtml(p.name) + '</span>';
      }).join("");
    }
    return (
      '<div class="waiting-section">' +
        '<div class="section-label">Waiting (' + waitingPlayers.length + ')' + (waitingPlayers.length ? ' · highlighted = next up' : '') + '</div>' +
        nextLine +
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
    html += buildRestoreBanner();
    html += buildSetupPanel(occupied);
    html += buildErrorBanner();
    html += buildActionsRow();
    html += buildLivePanel();
    if (state.sessionStarted) {
      html += buildCourtsGrid();
      html += buildWaitingSection(occupied);
      html += buildStandingsSection();
      html += buildHistorySection();
    }
    html += buildPastSessions();
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

  /* ---------- past sessions (saved when a session ends) ---------- */
  var ARCHIVE_KEY = "open-play-generator-archive-v1";
  var ARCHIVE_LIMIT = 20;

  // Always read the latest copy: several tabs can end sessions, and each must add to the
  // same list instead of overwriting what another tab saved.
  function readArchive() {
    try {
      var a = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  }

  function writeArchive(list) {
    try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list.slice(0, ARCHIVE_LIMIT))); } catch (e) {}
  }

  function namesOf(team) { return team.map(function (p) { return p.name; }); }

  // Keeps the leaderboard and every match, so ending a session never loses them.
  function archiveSession() {
    if (!state.history.length) return null;
    var standings = computeStandings().map(function (s) {
      return { name: s.name, wins: s.wins, losses: s.losses, matches: s.matches, pf: s.pf, pa: s.pa, diff: s.diff, rating: s.rating };
    });
    var matches = state.history.slice().reverse().map(function (h) {
      return { court: h.court + 1, num: h.matchNum, a: namesOf(h.teamA), b: namesOf(h.teamB), sa: h.scoreA, sb: h.scoreB, w: h.winner };
    });
    var entry = {
      id: "s-" + Date.now(),
      startedAt: state.sessionStartedAt || null,
      endedAt: Date.now(),
      courts: state.numCourts,
      courtMs: totalCourtMs(),
      players: state.players.length,
      standings: standings,
      matches: matches,
    };
    var list = readArchive().slice();
    list.unshift(entry);
    writeArchive(list);
    return entry.id;
  }

  function removeArchive(id) {
    writeArchive(readArchive().filter(function (e) { return e.id !== id; }));
  }

  function fmtWhen(ms) {
    return ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
  }

  function buildPastCard(e) {
    var open = state.pastViewId === e.id;
    var html = (
      '<div class="past-card">' +
        '<div class="past-head">' +
          '<div><div class="past-title">' + escapeHtml(fmtWhen(e.endedAt)) + '</div>' +
          '<div class="past-meta">' + e.matches.length + ' matches · ' + e.players + ' players · ' + e.courts + ' courts · ' + fmtDuration(e.courtMs || 0) + ' court time</div></div>' +
        '</div>' +
        '<div class="btn-row">' +
          '<button type="button" class="btn-ghost-small" data-action="view-past" data-id="' + escapeHtml(e.id) + '">' + (open ? "Hide" : "View") + '</button>' +
          '<button type="button" class="btn-ghost-small" data-action="download-past" data-id="' + escapeHtml(e.id) + '">' + ICONS.download(12) + ' CSV</button>' +
          '<button type="button" class="btn-ghost-small danger" data-action="delete-past" data-id="' + escapeHtml(e.id) + '">Delete</button>' +
        '</div>'
    );
    if (open) {
      html += '<div class="standings-table past-table">' +
        '<div class="standings-row standings-header"><span class="standings-rank">#</span><span class="standings-name">Player</span><span class="standings-record">W-L</span><span class="standings-matches">MP</span><span class="standings-pct">Win%</span><span class="standings-diff">+/-</span><span class="standings-rating">Rating</span></div>' +
        e.standings.map(function (s, i) {
          return buildStandingsRow({ name: s.name, wins: s.wins, losses: s.losses, matches: s.matches, diff: s.diff, rating: s.rating, winRate: s.matches ? s.wins / s.matches : 0 }, i + 1);
        }).join("") +
      '</div><div class="past-matches">' +
        e.matches.map(function (m) {
          return '<div class="past-match"><span class="past-match-court">C' + m.court + '</span> ' +
            '<span' + (m.w === "A" ? ' class="past-win"' : "") + '>' + escapeHtml(m.a.join(" & ")) + ' ' + m.sa + '</span> – ' +
            '<span' + (m.w === "B" ? ' class="past-win"' : "") + '>' + m.sb + ' ' + escapeHtml(m.b.join(" & ")) + '</span></div>';
        }).join("") +
      '</div>';
    }
    return html + '</div>';
  }

  function buildPastSessions() {
    var list = readArchive();
    if (!list.length) return "";
    return (
      '<div class="past-section">' +
        '<button type="button" class="past-toggle" data-action="toggle-past">' + ICONS.clock(13) + ' Past sessions (' + list.length + ') ' + (state.pastOpen ? "▲" : "▼") + '</button>' +
        (state.pastOpen ? list.map(buildPastCard).join("") : "") +
      '</div>'
    );
  }

  function downloadPast(id) {
    var e = readArchive().filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    var rows = [["Leaderboard"], ["Rank", "Player", "Wins", "Losses", "Matches", "Points for", "Points against", "Diff", "Rating"]];
    e.standings.forEach(function (s, i) {
      rows.push([i + 1, s.name, s.wins, s.losses, s.matches, s.pf, s.pa, s.diff, s.rating]);
    });
    rows.push([], ["Matches"], ["Court", "Match #", "Team A", "Team B", "Score A", "Score B", "Winner"]);
    e.matches.forEach(function (m) {
      rows.push([m.court, m.num, m.a.join(" & "), m.b.join(" & "), m.sa, m.sb, (m.w === "A" ? m.a : m.b).join(" & ")]);
    });
    var csv = rows.map(function (r) { return r.map(csvEscape).join(","); }).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "open-play-" + new Date(e.endedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- live view (QR code for players) ---------- */
  var CFG = window.OPG_CONFIG || {};
  var ACCESS_URL = CFG.ACCESS_URL || "";
  var liveTimer = null;
  var liveLastSent = "";

  function liveConfigured() {
    return !!ACCESS_URL && ACCESS_URL.indexOf("PASTE_") !== 0;
  }

  function randomId(len) {
    var chars = "abcdefghijkmnpqrstuvwxyz23456789", out = "", i;
    var arr = new Uint8Array(len);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(arr);
    else for (i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
    for (i = 0; i < len; i++) out += chars.charAt(arr[i] % chars.length);
    return out;
  }

  function liveUrl() {
    return new URL("live/?s=" + state.live.id, window.location.href).href;
  }

  // Waiting players in the order they are most likely to be called:
  // fewest games played first, then whoever has waited longest.
  function queueOrder() {
    var occupied = occupiedIds(state.courts);
    var gp = state.gamesPlayed, bo = state.benchOrder;
    return state.players.filter(function (p) { return !occupied[p.id] && !state.benched[p.id]; }).sort(function (a, b) {
      var d = (gp[a.id] || 0) - (gp[b.id] || 0);
      if (d !== 0) return d;
      d = (bo[a.id] || 0) - (bo[b.id] || 0);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }

  /* ---------- next pairs preview ---------- */
  // Works out who will play next and how they will be paired, using the same matchmaker
  // as the courts. The first match is what a free court will actually get (as long as the
  // waiting list doesn't change), so what players see on the QR page matches what happens.
  var previewCache = null;

  function matchKey(m) { return m.teamA.concat(m.teamB).sort().join("|"); }

  function updatePreview() {
    if (!state.sessionStarted) { previewCache = null; return; }
    var order = queueOrder();
    var sig = order.map(function (p) { return p.id; }).join(",") + "|" + JSON.stringify(state.lockedPairs);
    if (previewCache && previewCache.sig === sig) return;

    var prev = {};
    if (previewCache) previewCache.matches.forEach(function (m) { prev[matchKey(m)] = m; });

    // Keep the same NEXT match while those four are still the first four in line (e.g. when a
    // match finishes and its players join the back of the queue), so it doesn't flip around.
    var lp = JSON.stringify(state.lockedPairs), keep = null, byOrder = {};
    order.forEach(function (p) { byOrder[p.id] = p; });
    if (previewCache && previewCache.lp === lp && previewCache.matches.length) {
      var m0 = previewCache.matches[0], ids0 = m0.teamA.concat(m0.teamB), set0 = {};
      ids0.forEach(function (id) { set0[id] = 1; });
      if (ids0.length === 4 && ids0.every(function (id) { return byOrder[id]; })) {
        var maxGp = Math.max.apply(null, ids0.map(function (id) { return state.gamesPlayed[id] || 0; }));
        var overtaken = order.some(function (p) { return !set0[p.id] && (state.gamesPlayed[p.id] || 0) < maxGp; });
        if (!overtaken) keep = m0;
      }
    }

    var matches = [], pool = order.slice();
    var gp = Object.assign({}, state.gamesPlayed), ph = Object.assign({}, state.partnerHistory);
    var oh = Object.assign({}, state.opponentHistory);
    var recent = state.recentPartners.slice(), recentOpp = state.recentOpponents.slice();
    for (var n = 0; n < 3 && pool.length >= 4; n++) {
      var res;
      if (n === 0 && keep) {
        var kTA = keep.teamA.map(function (id) { return byOrder[id]; });
        var kTB = keep.teamB.map(function (id) { return byOrder[id]; });
        res = { four: kTA.concat(kTB), split: { teamA: kTA, teamB: kTB } };
      } else {
        try { res = resolveMatch(pool, gp, state.benchOrder, ph, oh, recent, recentOpp); } catch (e) { break; }
      }
      if (!res || !res.four || res.four.length !== 4) break;
      var m = {
        teamA: res.split.teamA.map(function (p) { return p.id; }),
        teamB: res.split.teamB.map(function (p) { return p.id; }),
      };
      // keep the earlier pairing if the same four are still next, so it doesn't flip around
      if (prev[matchKey(m)]) m = prev[matchKey(m)];
      matches.push(m);
      // simulate this match so the following one is worked out from the updated history
      res.four.forEach(function (p) { gp[p.id] = (gp[p.id] || 0) + 1; });
      var kA = pairKey(res.split.teamA[0].id, res.split.teamA[1].id);
      var kB = pairKey(res.split.teamB[0].id, res.split.teamB[1].id);
      ph[kA] = (ph[kA] || 0) + 1;
      ph[kB] = (ph[kB] || 0) + 1;
      recent.unshift(kA, kB);
      recent = recent.slice(0, RECENT_LIMIT);
      var cross = crossPairKeys(res.split.teamA, res.split.teamB);
      cross.forEach(function (k) { oh[k] = (oh[k] || 0) + 1; });
      recentOpp = cross.concat(recentOpp).slice(0, RECENT_OPP_LIMIT);
      var used = {};
      res.four.forEach(function (p) { used[p.id] = 1; });
      pool = pool.filter(function (p) { return !used[p.id]; });
    }
    previewCache = { sig: sig, lp: lp, matches: matches };
  }

  // The previewed next match, if all four are still waiting.
  function takePreview(waiting) {
    updatePreview();
    var m = previewCache && previewCache.matches[0];
    if (!m) return null;
    var byId = {};
    waiting.forEach(function (p) { byId[p.id] = p; });
    var ids = m.teamA.concat(m.teamB);
    if (!ids.every(function (id) { return byId[id]; })) return null;
    var tA = m.teamA.map(function (id) { return byId[id]; });
    var tB = m.teamB.map(function (id) { return byId[id]; });
    return { four: tA.concat(tB), split: { teamA: tA, teamB: tB } };
  }

  function previewNames(m) {
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = p.name; });
    return {
      a: m.teamA.map(function (id) { return byId[id]; }),
      b: m.teamB.map(function (id) { return byId[id]; }),
    };
  }

  function buildLiveSnapshot(ended) {
    var waiting = queueOrder();
    updatePreview();
    var matches = previewCache ? previewCache.matches : [];
    var inNext = {};
    matches.forEach(function (m) { m.teamA.concat(m.teamB).forEach(function (id) { inNext[id] = 1; }); });
    return {
      next: matches.map(previewNames),
      rest: waiting.filter(function (p) { return !inNext[p.id]; }).map(function (p) { return p.name; }),
      v: 1,
      t: Date.now(),
      ended: !!ended,
      courts: state.courts.map(function (c, i) {
        return c ? { n: i + 1, m: state.matchCounts[i], a: namesOf(c.teamA), b: namesOf(c.teamB) } : { n: i + 1, free: true };
      }),
      queue: waiting.map(function (p) { return p.name; }),
      onBreak: state.players.filter(function (p) { return state.benched[p.id]; }).map(function (p) { return p.name; }),
      standings: computeStandings().slice(0, 60).map(function (s) {
        return { n: s.name, w: s.wins, l: s.losses, mp: s.matches, d: s.diff, r: s.rating };
      }),
      history: state.history.slice(0, 40).map(function (h) {
        return { c: h.court + 1, m: h.matchNum, a: namesOf(h.teamA), b: namesOf(h.teamB), sa: h.scoreA, sb: h.scoreB, w: h.winner };
      }),
    };
  }

  function setLiveStatus(kind) {
    var text = {
      ok: "Live — updates are being sent.",
      error: "Couldn't send the latest update. Retrying.",
      forbidden: "This link isn't accepted by the server. Stop sharing and create a new QR code.",
      sending: "Sending…",
    }[kind] || "";
    var el = document.querySelector("[data-live-status]");
    if (el) el.textContent = text;
  }

  function pushLive(force, snapOverride, stop) {
    if (!state.live || !liveConfigured()) return;
    var snap = stop ? { v: 1, stopped: true, t: Date.now() } : (snapOverride || buildLiveSnapshot(false));
    var fingerprint = JSON.stringify(Object.assign({}, snap, { t: 0 }));
    if (!force && fingerprint === liveLastSent) return;
    var email = "", device = "";
    try { email = sessionStorage.getItem("gate-email") || ""; } catch (e) {}
    try { device = localStorage.getItem("opg-device-id") || ""; } catch (e) {}
    fetch(ACCESS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "live_push",
        id: state.live.id,
        token: state.live.token,
        email: email,
        device: device,
        snapshot: JSON.stringify(snap),
      }),
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.ok) { liveLastSent = fingerprint; setLiveStatus("ok"); }
      else setLiveStatus(res && res.reason === "forbidden" ? "forbidden" : "error");
    }).catch(function () { setLiveStatus("error"); });
  }

  function scheduleLivePush() {
    if (!state.live || !liveConfigured()) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () { pushLive(false); }, 1200);
  }

  function startLive() {
    if (!liveConfigured()) { state.error = "Live sharing needs ACCESS_URL set in config.js."; render(); return; }
    state.live = { id: randomId(12), token: randomId(32) };
    state.liveOpen = true;
    liveLastSent = "";
    render();
    pushLive(true);
  }

  function stopLive() {
    pushLive(true, null, true);
    state.live = null;
    state.liveOpen = false;
    liveLastSent = "";
    render();
  }

  function copyLiveLink() {
    if (!state.live) return;
    var url = liveUrl();
    function done() { showToast("Link copied", ICONS.check); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { showToast("Press and hold the link to copy it", ICONS.check); });
    } else {
      showToast("Press and hold the link to copy it", ICONS.check);
    }
  }

  function buildLivePanel() {
    if (!state.sessionStarted || !state.liveOpen) return "";
    var body;
    if (!liveConfigured()) {
      body = '<p class="live-note">Live sharing needs the access server. Set <b>ACCESS_URL</b> in config.js first.</p>';
    } else if (!state.live) {
      body = (
        '<p class="live-note">Players scan a QR code to see who is on court, who is up next, scores and the leaderboard — live on their own phones.</p>' +
        '<button type="button" class="btn-primary" data-action="start-live">Create QR code</button>'
      );
    } else {
      var url = liveUrl(), qr = "";
      try { qr = window.OPG_QR ? window.OPG_QR.svg(url, { label: "QR code for the live view" }) : ""; } catch (e) {}
      body = (
        '<div class="live-qr">' + qr + '</div>' +
        '<a class="live-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>' +
        '<div class="btn-row">' +
          '<button type="button" class="btn-small" data-action="copy-live">Copy link</button>' +
          '<button type="button" class="btn-ghost-small danger" data-action="stop-live">Stop sharing</button>' +
        '</div>' +
        '<p class="live-note" data-live-status></p>' +
        '<p class="live-note">Anyone with this link can see player names, scores and the leaderboard. It updates while this page stays open.</p>'
      );
    }
    return '<div class="live-panel"><div class="section-label">Live view</div>' + body + '</div>';
  }

  function buildRestoreBanner() {
    var offers = state.restoreOffers || [];
    if (!offers.length) return "";
    var html = '<div class="restore-banner"><div class="restore-title">' +
      (offers.length > 1 ? "Restore a saved session?" : "Restore your last session?") + '</div>';
    offers.forEach(function (o) {
      var secs = Math.round((Date.now() - o.savedAt) / 1000), mins = Math.round(secs / 60);
      var ago = secs < 90 ? secs + "s ago" : mins < 60 ? mins + " min ago" : Math.round(mins / 60) + " h ago";
      html += (
        '<div class="restore-item">' +
          '<div class="restore-text">Saved ' + ago + ' · ' + o.players + ' players' +
          (o.started ? ' · ' + o.matches + ' matches played' : '') +
          (secs < 30 ? ' · may still be open in another tab' : '') + '</div>' +
          '<div class="btn-row">' +
            '<button type="button" class="btn-small" data-action="restore-backup" data-key="' + escapeHtml(o.key) + '">Restore</button>' +
            '<button type="button" class="btn-ghost-small" data-action="dismiss-backup" data-key="' + escapeHtml(o.key) + '">Discard</button>' +
          '</div>' +
        '</div>'
      );
    });
    return html + '<div class="restore-text">Court timers keep running while a tab is closed.</div></div>';
  }

  /* ---------- persistence ---------- */
  var BASE_STORAGE_KEY = "open-play-generator-state-v1";
  // Every tab also keeps its own copy on the device, so closing a tab by accident doesn't lose
  // its session. A new tab lists the saved sessions of tabs that were closed.
  var BACKUP_PREFIX = "open-play-generator-backup-v2:";
  var LEGACY_BACKUP_KEY = "open-play-generator-backup-v1";
  var BACKUP_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  var MAX_OFFERS = 5;
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

  function hasContent() {
    return state.players.length > 0 || state.sessionStarted;
  }

  function currentSaveData() {
    return {
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
      courtTimers: state.courtTimers,
      retiredMs: state.retiredMs,
      sessionStartedAt: state.sessionStartedAt,
      live: state.live,
    };
  }

  function writeBackup() {
    try {
      var k = BACKUP_PREFIX + getTabId();
      if (hasContent()) localStorage.setItem(k, JSON.stringify({ savedAt: Date.now(), data: currentSaveData() }));
      else localStorage.removeItem(k);
    } catch (e) {
      // storage unavailable — fail silently
    }
  }

  function saveState() {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify(currentSaveData()));
    } catch (e) {
      // sessionStorage unavailable (private browsing, quota, etc.) — fail silently
    }
    writeBackup();
  }

  function applySaved(saved) {
    Object.keys(saved).forEach(function (key) {
      state[key] = saved[key];
    });
    relinkPlayers();
  }

  // Saved sessions from other tabs (newest first). Old or empty ones are cleaned up.
  function findOffers() {
    var offers = [], ownKey = BACKUP_PREFIX + getTabId(), now = Date.now(), keys = [], i;
    try {
      for (i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf(BACKUP_PREFIX) === 0 || k === LEGACY_BACKUP_KEY)) keys.push(k);
      }
      keys.forEach(function (k) {
        if (k === ownKey) return;
        var b = null;
        try { b = JSON.parse(localStorage.getItem(k)); } catch (e) {}
        var d = b && b.data;
        if (!b || !d || !b.savedAt || now - b.savedAt > BACKUP_MAX_AGE_MS || !((d.players && d.players.length) || d.sessionStarted)) {
          localStorage.removeItem(k);
          return;
        }
        offers.push({
          key: k,
          savedAt: b.savedAt,
          players: (d.players || []).length,
          matches: (d.history || []).length,
          started: !!d.sessionStarted,
          data: d,
        });
      });
    } catch (e) {}
    offers.sort(function (a, b) { return b.savedAt - a.savedAt; });
    return offers.slice(0, MAX_OFFERS);
  }

  function loadState() {
    try {
      var raw = sessionStorage.getItem(storageKey());
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && typeof saved === "object") {
          applySaved(saved);
          if (hasContent()) return;
        }
      }
    } catch (e) {
      // corrupted or inaccessible storage — fall through to the device backups
    }
    // A new (or still empty) tab: offer the sessions of tabs that were closed.
    state.restoreOffers = findOffers();
  }

  function restoreBackup(key) {
    var o = (state.restoreOffers || []).filter(function (x) { return x.key === key; })[0];
    if (!o) return;
    if (hasContent() && !window.confirm("Replace what is in this tab with the saved session?")) return;
    state.restoreOffers = state.restoreOffers.filter(function (x) { return x.key !== key; });
    try { localStorage.removeItem(key); } catch (e) {}
    applySaved(o.data);
    render();
    if (state.live) pushLive(true);
    showToast("Session restored", ICONS.check);
  }

  function dismissBackup(key) {
    if (!window.confirm("Discard this saved session? It can't be brought back.")) return;
    state.restoreOffers = (state.restoreOffers || []).filter(function (x) { return x.key !== key; });
    try { localStorage.removeItem(key); } catch (e) {}
    render();
  }

  function render() {
    reconcileTimers();
    captureFocus();
    root.innerHTML = buildHTML();
    restoreFocus();
    saveState();
    scheduleLivePush();
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
    else if (action === "undo") undo();
    else if (action === "toggle-court-timer") toggleCourtTimer(ci);
    else if (action === "toggle-live-panel") { state.liveOpen = !state.liveOpen; render(); }
    else if (action === "start-live") startLive();
    else if (action === "stop-live") stopLive();
    else if (action === "copy-live") copyLiveLink();
    else if (action === "restore-backup") restoreBackup(btn.dataset.key);
    else if (action === "dismiss-backup") dismissBackup(btn.dataset.key);
    else if (action === "toggle-past") { state.pastOpen = !state.pastOpen; render(); }
    else if (action === "view-past") { state.pastViewId = state.pastViewId === btn.dataset.id ? null : btn.dataset.id; render(); }
    else if (action === "download-past") downloadPast(btn.dataset.id);
    else if (action === "delete-past") {
      if (window.confirm("Delete this saved session?")) { removeArchive(btn.dataset.id); if (state.pastViewId === btn.dataset.id) state.pastViewId = null; render(); }
    }
    else if (action === "courts-inc") changeCourts(1);
    else if (action === "courts-dec") changeCourts(-1);
  }

  function handleInput(e) {
    var t = e.target;
    if (t.id === "name-input") {
      state.nameInput = t.value;
    } else if (t.id === "bulk-add-input") {
      state.bulkAddText = t.value;
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
    setInterval(updateTimers, 1000);
    // refresh this tab's saved copy now and then, even when nothing changes
    setInterval(writeBackup, 10000);
    // keep the live view fresh even when nothing changes
    setInterval(function () { if (state.live && !document.hidden) pushLive(true); }, 20000);
    if (state.live) pushLive(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
