/* Minimal QR code generator (byte mode, error correction M, versions 1-10).
 * Exposes window.OPG_QR.matrix(text) and window.OPG_QR.svg(text).
 * No dependencies, works offline. */
(function () {
  "use strict";

  var EXP = [], LOG = [];
  (function () {
    var x = 1, i;
    for (i = 0; i < 256; i++) { EXP[i] = 0; LOG[i] = 0; }
    for (i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 256) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }

  function rsGenerator(n) {
    var g = [1], i, j;
    for (i = 0; i < n; i++) {
      var ng = [];
      for (j = 0; j <= g.length; j++) ng.push(0);
      for (j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function rsRemainder(data, n) {
    var g = rsGenerator(n), res = [], i;
    for (i = 0; i < n; i++) res.push(0);
    data.forEach(function (d) {
      var f = d ^ res[0];
      res.shift();
      res.push(0);
      for (i = 0; i < n; i++) res[i] ^= gmul(g[i + 1], f);
    });
    return res;
  }

  // Error correction level M: ec codewords per block, and [blockCount, dataCodewordsPerBlock] groups.
  var VERSIONS = {
    1: { ec: 10, b: [[1, 16]] },
    2: { ec: 16, b: [[1, 28]] },
    3: { ec: 26, b: [[1, 44]] },
    4: { ec: 18, b: [[2, 32]] },
    5: { ec: 24, b: [[2, 43]] },
    6: { ec: 16, b: [[4, 27]] },
    7: { ec: 18, b: [[4, 31]] },
    8: { ec: 22, b: [[2, 38], [2, 39]] },
    9: { ec: 22, b: [[3, 36], [2, 37]] },
    10: { ec: 26, b: [[4, 43], [1, 44]] }
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function dataCapacity(v) {
    return VERSIONS[v].b.reduce(function (a, g) { return a + g[0] * g[1]; }, 0);
  }

  function utf8Bytes(text) {
    var s = unescape(encodeURIComponent(text)), out = [], i;
    for (i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function encodeData(bytes, version) {
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var cap = dataCapacity(version) * 8;
    for (var t = 0; t < 4 && bits.length < cap; t++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var out = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      out.push(v);
    }
    var pad = [0xec, 0x11], p = 0;
    while (out.length < dataCapacity(version)) { out.push(pad[p % 2]); p++; }
    return out;
  }

  function interleave(data, version) {
    var info = VERSIONS[version], blocks = [], pos = 0, g, k;
    info.b.forEach(function (grp) {
      for (k = 0; k < grp[0]; k++) {
        var d = data.slice(pos, pos + grp[1]);
        pos += grp[1];
        blocks.push({ data: d, ec: rsRemainder(d, info.ec) });
      }
    });
    var out = [], maxLen = 0;
    blocks.forEach(function (b) { if (b.data.length > maxLen) maxLen = b.data.length; });
    for (k = 0; k < maxLen; k++) blocks.forEach(function (b) { if (k < b.data.length) out.push(b.data[k]); });
    for (k = 0; k < info.ec; k++) blocks.forEach(function (b) { out.push(b.ec[k]); });
    return out;
  }

  function build(text) {
    var bytes = utf8Bytes(text), version = 0, v;
    for (v = 1; v <= 10; v++) {
      var need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error("QR text too long");

    var size = 17 + 4 * version;
    var mod = [], fn = [], y, x;
    for (y = 0; y < size; y++) {
      mod.push([]); fn.push([]);
      for (x = 0; x < size; x++) { mod[y].push(false); fn[y].push(false); }
    }
    function setFn(px, py, dark) {
      if (px < 0 || py < 0 || px >= size || py >= size) return;
      mod[py][px] = dark;
      fn[py][px] = true;
    }

    // timing
    for (var i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    // finders + separators
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    // alignment
    var al = ALIGN[version], n = al.length;
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
        setFn(al[a] + dx, al[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    function drawFormat(mask) {
      var data = (0 << 3) | mask; // level M = 00
      var rem = data, k;
      for (k = 0; k < 10; k++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      for (k = 0; k <= 5; k++) setFn(8, k, getBit(bits, k));
      setFn(8, 7, getBit(bits, 6));
      setFn(8, 8, getBit(bits, 7));
      setFn(7, 8, getBit(bits, 8));
      for (k = 9; k < 15; k++) setFn(14 - k, 8, getBit(bits, k));
      for (k = 0; k < 8; k++) setFn(size - 1 - k, 8, getBit(bits, k));
      for (k = 8; k < 15; k++) setFn(8, size - 15 + k, getBit(bits, k));
      setFn(8, size - 8, true);
    }
    drawFormat(0);

    if (version >= 7) {
      var rem2 = version, k2;
      for (k2 = 0; k2 < 12; k2++) rem2 = (rem2 << 1) ^ ((rem2 >>> 11) * 0x1f25);
      var vbits = (version << 12) | rem2;
      for (k2 = 0; k2 < 18; k2++) {
        var col = getBit(vbits, k2), aa = size - 11 + (k2 % 3), bb = Math.floor(k2 / 3);
        setFn(aa, bb, col);
        setFn(bb, aa, col);
      }
    }

    // place data
    var all = interleave(encodeData(bytes, version), version);
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var px = right - j;
          var upward = ((right + 1) & 2) === 0;
          var py = upward ? size - 1 - vert : vert;
          if (!fn[py][px] && idx < all.length * 8) {
            mod[py][px] = getBit(all[idx >>> 3], 7 - (idx & 7));
            idx++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) {
        if (fn[yy][xx]) continue;
        var inv;
        switch (mask) {
          case 0: inv = (xx + yy) % 2 === 0; break;
          case 1: inv = yy % 2 === 0; break;
          case 2: inv = xx % 3 === 0; break;
          case 3: inv = (xx + yy) % 3 === 0; break;
          case 4: inv = (Math.floor(xx / 3) + Math.floor(yy / 2)) % 2 === 0; break;
          case 5: inv = (xx * yy) % 2 + (xx * yy) % 3 === 0; break;
          case 6: inv = ((xx * yy) % 2 + (xx * yy) % 3) % 2 === 0; break;
          default: inv = ((xx + yy) % 2 + (xx * yy) % 3) % 2 === 0; break;
        }
        if (inv) mod[yy][xx] = !mod[yy][xx];
      }
    }

    function penalty() {
      var score = 0, yy, xx, run, k;
      function lineScore(get) {
        var s = 0, r = 1;
        for (var q = 1; q < size; q++) {
          if (get(q) === get(q - 1)) { r++; } else { if (r >= 5) s += 3 + (r - 5); r = 1; }
        }
        if (r >= 5) s += 3 + (r - 5);
        return s;
      }
      for (yy = 0; yy < size; yy++) {
        score += lineScore(function (q) { return mod[yy][q]; });
        score += lineScore(function (q) { return mod[q][yy]; });
      }
      for (yy = 0; yy < size - 1; yy++) for (xx = 0; xx < size - 1; xx++) {
        var c = mod[yy][xx];
        if (c === mod[yy][xx + 1] && c === mod[yy + 1][xx] && c === mod[yy + 1][xx + 1]) score += 3;
      }
      var pat = [true, false, true, true, true, false, true, false, false, false, false];
      var pat2 = pat.slice().reverse();
      function matches(get, start, p) {
        for (var q = 0; q < 11; q++) if (get(start + q) !== p[q]) return false;
        return true;
      }
      for (yy = 0; yy < size; yy++) for (xx = 0; xx <= size - 11; xx++) {
        if (matches(function (q) { return mod[yy][q]; }, xx, pat) || matches(function (q) { return mod[yy][q]; }, xx, pat2)) score += 40;
        if (matches(function (q) { return mod[q][yy]; }, xx, pat) || matches(function (q) { return mod[q][yy]; }, xx, pat2)) score += 40;
      }
      var dark = 0;
      for (yy = 0; yy < size; yy++) for (xx = 0; xx < size; xx++) if (mod[yy][xx]) dark++;
      var pct = (dark * 100) / (size * size);
      k = Math.floor(Math.abs(pct - 50) / 5);
      score += k * 10;
      return score;
    }

    var best = 0, bestScore = Infinity, m;
    for (m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      var sc = penalty();
      if (sc < bestScore) { bestScore = sc; best = m; }
      applyMask(m); // undo (xor is its own inverse)
    }
    applyMask(best);
    drawFormat(best);
    return mod;
  }

  function svg(text, opts) {
    var m = build(text), size = m.length, quiet = 4, total = size + quiet * 2, d = "", y, x;
    for (y = 0; y < size; y++) {
      x = 0;
      while (x < size) {
        if (m[y][x]) {
          var start = x;
          while (x < size && m[y][x]) x++;
          d += "M" + (start + quiet) + " " + (y + quiet) + "h" + (x - start) + "v1h-" + (x - start) + "z";
        } else { x++; }
      }
    }
    var label = (opts && opts.label) || "QR code";
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" role="img" aria-label="' + label + '" shape-rendering="crispEdges">' +
      '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
      '<path d="' + d + '" fill="#000000"/></svg>'
    );
  }

  window.OPG_QR = { matrix: build, svg: svg };
})();
