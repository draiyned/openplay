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

function doGet(e) {
  var p = (e && e.parameter) || {};
  var email = String(p.email || "").trim().toLowerCase();
  var device = String(p.device || "").trim().slice(0, 80);
  var ua = String(p.ua || "").slice(0, 200);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !device) {
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
      // a new email/device combo is logged as "blocked" if either half is already blocked
      sh.appendRow([email, device, blocked ? "blocked" : "allowed", now, now, 1, ua]);
    }
    return json_({ allowed: !blocked, reason: blocked ? "blocked" : "ok" });
  } finally {
    lock.releaseLock();
  }
}
