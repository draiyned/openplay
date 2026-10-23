/**
 * Open Play access log + block list (Google Apps Script).
 *
 * Setup: see README "Email log and device blocking".
 * The sheet "Access" is created automatically with these columns:
 *   A Email | B Device ID | C Status | D First seen | E Last seen | F Visits | G Browser
 * Status is "allowed" or "blocked". Change it by hand in the sheet.
 * A visitor is refused if ANY row matching their email OR their device ID says "blocked".
 * To unblock someone, set every row with their email / device ID back to "allowed".
 */
var SHEET_NAME = "Access";
// Paste the same Google OAuth Web client ID used in index.html. While this
// is left as-is, typed (unverified) emails are accepted.
var GOOGLE_CLIENT_ID = "PASTE_GOOGLE_CLIENT_ID_HERE";

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

// Sheets treats text starting with = + - @ as a formula. Anything a visitor
// controls is neutralized before it is written, so a crafted request can't
// plant a formula in your sheet.
function safeCell_(v) {
  v = String(v);
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

// Asks Google whether the sign-in token is genuine and meant for this app.
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
