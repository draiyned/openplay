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

function doGet() {
  return json_({ allowed: false, reason: "use_post" });
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ allowed: false, reason: "invalid" }); }
  var action = String(body.action || "check");
  if (action === "list" || action === "set") return admin_(action, body);
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
      sh.getRange(matchRow, 5).setValue(now);
      sh.getRange(matchRow, 6).setValue((Number(sh.getRange(matchRow, 6).getValue()) || 0) + 1);
    } else {
      sh.appendRow([email, device, blocked ? "blocked" : "allowed", now, now, 1, safeCell_(ua)]);
    }
    return json_({ allowed: !blocked, reason: blocked ? "blocked" : "ok", email: email });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- admin: list and block / unblock ---------- */
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
    return json_({ ok: true, rows: listRows_(sh) });
  } finally {
    lock.releaseLock();
  }
}
