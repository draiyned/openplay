/**
 * Open Play access log, block list and admin API (Google Apps Script).
 * The "Access" sheet is the database; manage it from the site's /admin/ page.
 * Columns: A Email | B Device ID | C Status | D First seen | E Last seen | F Visits | G Browser
 * A visitor is refused if ANY row matching their email OR their device ID is "blocked".
 */
var SHEET_NAME = "Access";
// Same Google OAuth Web client ID as config.js. While left as-is, typed (unverified) emails are accepted.
var GOOGLE_CLIENT_ID = "PASTE_GOOGLE_CLIENT_ID_HERE";
// Your private key for the /admin/ page (12+ characters). Lives only in this script.
var ADMIN_KEY = "PASTE_ADMIN_KEY_HERE";
// Where sign-in alerts go. Leave empty to use the Google account that owns this script.
var NOTIFY_EMAIL = "";
// Safety cap so a flood of fake sign-ins can't fill your inbox or use up Gmail's daily limit.
var MAX_MAILS_PER_HOUR = 30;

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(["Email", "Device ID", "Status", "First seen", "Last seen", "Visits", "Browser"]);
    sh.setFrozenRows(1);
    sh.getRange("C2:C").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["allowed", "blocked"], true).build()
    );
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Sheets treats text starting with = + - @ as a formula; neutralize visitor-controlled text.
function safeCell_(v) {
  v = String(v);
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function verifiedEmail_(credential) {
  if (!credential) return "";
  var res = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return "";
  var info = JSON.parse(res.getContentText());
  if (info.aud !== GOOGLE_CLIENT_ID) return "";
  if (String(info.email_verified) !== "true") return "";
  if (info.iss !== "https://accounts.google.com" && info.iss !== "accounts.google.com") return "";
  if (Number(info.exp) < Date.now() / 1000) return "";
  return String(info.email || "").toLowerCase();
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === "live") return liveGet_(String(p.id || ""));
  return json_({ allowed: false, reason: "use_post" });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ allowed: false, reason: "invalid" }); }
  var action = String(body.action || "check");
  if (action === "list" || action === "set") return admin_(action, body);
  if (action === "status") return status_(body);
  if (action === "live_push") return livePush_(body);
  return check_(body);
}

/* ---------- visitor sign-in check ---------- */
function check_(body) {
  var email;
  if (GOOGLE_CLIENT_ID.indexOf("PASTE_") !== 0) {
    email = verifiedEmail_(String(body.credential || ""));
    if (!email) return json_({ allowed: false, reason: "unverified" });
  } else {
    email = String(body.email || "").trim().toLowerCase();
  }
  var device = String(body.device || "").trim().slice(0, 80);
  var ua = String(body.ua || "").slice(0, 200);

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /^[=+\-@]/.test(email) ||
    email.length > 200 ||
    !/^[A-Za-z0-9-]{1,80}$/.test(device)
  ) {
    return json_({ allowed: false, reason: "invalid" });
  }

  var lock = LockService.getScriptLock();
  var result, visits = 1;
  lock.waitLock(10000);
  try {
    var sh = getSheet_();
    var rows = sh.getDataRange().getValues();
    var blocked = false;
    var matchRow = -1;
    for (var i = 1; i < rows.length; i++) {
      var rEmail = String(rows[i][0]).toLowerCase();
      var rDevice = String(rows[i][1]);
      var rStatus = String(rows[i][2]).toLowerCase();
      if (rStatus === "blocked" && (rEmail === email || rDevice === device)) blocked = true;
      if (rEmail === email && rDevice === device) matchRow = i + 1;
    }
    var now = new Date();
    if (matchRow > 0) {
      visits = (Number(sh.getRange(matchRow, 6).getValue()) || 0) + 1;
      sh.getRange(matchRow, 5).setValue(now);
      sh.getRange(matchRow, 6).setValue(visits);
    } else {
      visits = 1;
      sh.appendRow([email, device, blocked ? "blocked" : "allowed", now, now, 1, safeCell_(ua)]);
    }
    result = { allowed: !blocked, reason: blocked ? "blocked" : "ok", email: email };
  } finally {
    lock.releaseLock();
  }
  notify_(email, device, ua, blocked, visits);
  return json_(result);
}

/* ---------- admin: list and block / unblock ---------- */
/* ---------- email alert on every sign-in ---------- */
function notify_(email, device, ua, blocked, visits) {
  try {
    var to = NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
    if (!to) return;
    var cache = CacheService.getScriptCache();
    var bucket = "mail_" + Math.floor(Date.now() / 3600000);
    var n = Number(cache.get(bucket) || 0);
    if (n >= MAX_MAILS_PER_HOUR) return;
    if (MailApp.getRemainingDailyQuota() < 1) return;
    cache.put(bucket, String(n + 1), 3700);
    var when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss z");
    MailApp.sendEmail(
      to,
      (blocked ? "[BLOCKED attempt] " : "Open Play sign-in: ") + email.slice(0, 80),
      "Account: " + email + "\n" +
      "Result: " + (blocked ? "BLOCKED (on hold)" : "allowed") + "\n" +
      "Time: " + when + "\n" +
      "Visits: " + visits + "\n" +
      "Device: " + device.slice(0, 8) + "\n" +
      "Browser: " + ua
    );
  } catch (err) {
    // an email problem must never stop someone from signing in
  }
}

// Run this once from the editor (Run button) to approve the email permission.
function authorize_() {
  Logger.log("Mails left today: " + MailApp.getRemainingDailyQuota());
  Logger.log("Alerts go to: " + (NOTIFY_EMAIL || Session.getEffectiveUser().getEmail()));
}

/* ---------- live check used by the site to close blocked sessions ---------- */
function blocklist_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get("bl");
  if (hit) return JSON.parse(hit);
  var vals = getSheet_().getDataRange().getValues();
  var bl = { emails: {}, devices: {} };
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][2]).toLowerCase() === "blocked") {
      bl.emails[String(vals[i][0]).toLowerCase()] = true;
      bl.devices[String(vals[i][1])] = true;
    }
  }
  cache.put("bl", JSON.stringify(bl), 30);
  return bl;
}

function status_(body) {
  var email = String(body.email || "").trim().toLowerCase();
  var device = String(body.device || "").trim().slice(0, 80);
  var bl = blocklist_();
  return json_({ allowed: !(bl.emails[email] || bl.devices[device]) });
}

/* ---------- live view for players (QR code page) ---------- */
// The host's page pushes a small snapshot (courts, queue, leaderboard, recent
// results); the public /live/ page reads it. Snapshots live in the script cache
// for up to 6 hours; only the host that created a link (it holds a secret token)
// can update it.
var LIVE_TTL = 21600;
var LIVE_MAX_CHARS = 50000;

function liveHash_(token) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
}

function liveGet_(id) {
  if (!/^[a-z0-9]{8,32}$/.test(id)) return json_({ ok: false, reason: "invalid" });
  var raw = CacheService.getScriptCache().get("live_s_" + id);
  if (!raw) return json_({ ok: false, reason: "none" });
  try { return json_({ ok: true, snap: JSON.parse(raw) }); } catch (err) { return json_({ ok: false, reason: "none" }); }
}

function knownSignIn_(email, device) {
  if (!email || !device) return false;
  var bl = blocklist_();
  if (bl.emails[email] || bl.devices[device]) return false;
  var vals = getSheet_().getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]).toLowerCase() === email && String(vals[i][1]) === device) return true;
  }
  return false;
}

function cleanupLive_(props) {
  var all = props.getProperties(), keys = [], cutoff = Date.now() - 24 * 3600 * 1000;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("live_") !== 0) return;
    var t = 0;
    try { t = JSON.parse(all[k]).t || 0; } catch (err) {}
    if (t < cutoff) props.deleteProperty(k); else keys.push({ k: k, t: t });
  });
  if (keys.length > 200) {
    keys.sort(function (a, b) { return a.t - b.t; });
    keys.slice(0, keys.length - 200).forEach(function (x) { props.deleteProperty(x.k); });
  }
}

function livePush_(body) {
  var id = String(body.id || ""), token = String(body.token || "");
  if (!/^[a-z0-9]{8,32}$/.test(id) || token.length < 16 || token.length > 64) return json_({ ok: false, reason: "invalid" });
  var snapStr = String(body.snapshot || "");
  if (!snapStr || snapStr.length > LIVE_MAX_CHARS) return json_({ ok: false, reason: "too_big" });
  try {
    var parsed = JSON.parse(snapStr);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json_({ ok: false, reason: "invalid" });
  } catch (err) {
    return json_({ ok: false, reason: "invalid" });
  }

  var props = PropertiesService.getScriptProperties();
  var key = "live_" + id;
  var hash = liveHash_(token);
  var cur = props.getProperty(key);
  if (cur) {
    var meta = {};
    try { meta = JSON.parse(cur); } catch (err) {}
    if (meta.h !== hash) return json_({ ok: false, reason: "forbidden" });
    if (Date.now() - (meta.t || 0) > 600000) props.setProperty(key, JSON.stringify({ h: hash, t: Date.now() }));
  } else {
    // a new link can only be created by someone who has signed in and isn't blocked
    if (!knownSignIn_(String(body.email || "").trim().toLowerCase(), String(body.device || "").trim())) {
      return json_({ ok: false, reason: "forbidden" });
    }
    cleanupLive_(props);
    props.setProperty(key, JSON.stringify({ h: hash, t: Date.now() }));
  }
  CacheService.getScriptCache().put("live_s_" + id, snapStr, LIVE_TTL);
  return json_({ ok: true });
}

function iso_(v) {
  return v instanceof Date ? v.toISOString() : String(v || "");
}

function listRows_(sh) {
  var vals = sh.getDataRange().getValues();
  var blockedEmails = {}, blockedDevices = {}, out = [], i;
  for (i = 1; i < vals.length; i++) {
    if (String(vals[i][2]).toLowerCase() === "blocked") {
      blockedEmails[String(vals[i][0]).toLowerCase()] = true;
      blockedDevices[String(vals[i][1])] = true;
    }
  }
  for (i = 1; i < vals.length; i++) {
    var em = String(vals[i][0]).toLowerCase();
    var dv = String(vals[i][1]);
    out.push({
      row: i + 1,
      email: em,
      device: dv,
      status: String(vals[i][2]).toLowerCase(),
      blocked: !!(blockedEmails[em] || blockedDevices[dv]),
      first: iso_(vals[i][3]),
      last: iso_(vals[i][4]),
      visits: Number(vals[i][5]) || 0,
      ua: String(vals[i][6] || "")
    });
  }
  return out;
}

function admin_(action, body) {
  if (ADMIN_KEY.indexOf("PASTE_") === 0 || ADMIN_KEY.length < 12) return json_({ ok: false, reason: "admin_disabled" });

  // 8 wrong keys locks the admin API for 15 minutes
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get("admin_fails") || 0);
  if (fails >= 8) return json_({ ok: false, reason: "locked" });
  if (String(body.key || "") !== ADMIN_KEY) {
    cache.put("admin_fails", String(fails + 1), 900);
    return json_({ ok: false, reason: "bad_key" });
  }
  cache.remove("admin_fails");

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = getSheet_();
    if (action === "set") {
      var rowNum = Number(body.row);
      var to = body.status === "blocked" ? "blocked" : "allowed";
      var vals = sh.getDataRange().getValues();
      if (!(rowNum >= 2 && rowNum <= vals.length)) return json_({ ok: false, reason: "no_row" });
      var target = vals[rowNum - 1];
      var tEmail = String(target[0]).toLowerCase();
      var tDevice = String(target[1]);
      if (tEmail !== String(body.email || "").toLowerCase()) return json_({ ok: false, reason: "stale" });
      if (to === "blocked") {
        sh.getRange(rowNum, 3).setValue("blocked");
      } else {
        // clear every hold tied to this email or this device
        for (var i = 1; i < vals.length; i++) {
          var linked = String(vals[i][0]).toLowerCase() === tEmail || String(vals[i][1]) === tDevice;
          if (linked && String(vals[i][2]).toLowerCase() === "blocked") sh.getRange(i + 1, 3).setValue("allowed");
        }
      }
    }
    if (action === "set") cache.remove("bl");
    return json_({ ok: true, rows: listRows_(sh) });
  } finally {
    lock.releaseLock();
  }
}
