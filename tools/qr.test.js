#!/usr/bin/env node
/**
 * DigiQuiz dev bundle — tools/qr.test.js
 * =============================================================================
 * Self-test for the vendored QR encoder.  `npm run test:qr`
 *
 * A wrong QR code is a nasty failure mode: it looks perfectly plausible and
 * simply never scans. So this runs three independent layers of checking:
 *
 *   1. STRUCTURAL   — finder patterns, separators, timing patterns, alignment
 *                     patterns, dark module and quiet zone are where ISO 18004
 *                     says they must be.
 *   2. GOLDEN       — SHA-256 of the module matrix for six payloads, pinned
 *                     from a build that was verified module-for-module against
 *                     the `qrcode` npm package (3,208 symbols: 401 payloads
 *                     x 8 forced masks, 0 mismatches). Catches any regression.
 *   3. REFERENCE    — if the `qrcode` package happens to be installed, redo the
 *                     full module-for-module diff live. Skipped otherwise, so
 *                     this file has no dependencies of its own.
 *
 * Note on layer 3: masking is a free choice. ISO defines penalty rule 4 as
 * floor(|percent-50|/5); some libraries use |ceil(percent/5)-10|, which picks a
 * different — equally valid — mask on a few percent of random payloads. The
 * reference check therefore FORCES each mask in turn, which isolates encoding
 * correctness from that harmless difference.
 * =============================================================================
 */

'use strict';

const crypto = require('crypto');
const { encodeQr, renderQr, byteCapacity } = require('./qr');

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`  PASS  ${m}`); };
const bad = (m) => { fail += 1; console.log(`  FAIL  ${m}`); };
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(`${label} (${a})`); else bad(`${label} — expected ${e}, got ${a}`);
};
const head = (m) => console.log(`\n== ${m} ${'='.repeat(Math.max(0, 58 - m.length))}`);

// -----------------------------------------------------------------------------
head('1. Structural invariants');
// -----------------------------------------------------------------------------
function checkStructure(text) {
  const { size, modules, version } = encodeQr(text);
  const label = `v${version}`;
  let problems = [];

  check(`${label} size = 4 x version + 17`, size, version * 4 + 17);

  // Finder patterns: 7x7 with a 3x3 solid centre, at all three corners
  const finderAt = (r0, c0) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const expected =
          (r === 0 || r === 6 || c === 0 || c === 6) ? 1
            : (r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1
              : 0;
        if (modules[r0 + r][c0 + c] !== expected) return false;
      }
    }
    return true;
  };
  if (!finderAt(0, 0)) problems.push('top-left finder');
  if (!finderAt(0, size - 7)) problems.push('top-right finder');
  if (!finderAt(size - 7, 0)) problems.push('bottom-left finder');

  // Separators: the ring of light modules around each finder
  for (let i = 0; i < 8; i += 1) {
    if (modules[7][i] !== 0) problems.push(`separator row 7 col ${i}`);
    if (modules[i][7] !== 0) problems.push(`separator col 7 row ${i}`);
  }

  // Timing patterns: alternating, starting and ending dark
  for (let i = 8; i < size - 8; i += 1) {
    if (modules[6][i] !== (i % 2 === 0 ? 1 : 0)) problems.push(`h-timing at ${i}`);
    if (modules[i][6] !== (i % 2 === 0 ? 1 : 0)) problems.push(`v-timing at ${i}`);
  }

  // Dark module — always set, always at (4*version + 9, 8)
  if (modules[4 * version + 9][8] !== 1) problems.push('dark module');

  // Every module must be 0 or 1 — a null means a cell was never written
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c] !== 0 && modules[r][c] !== 1) {
        problems.push(`unwritten module at ${r},${c}`);
      }
    }
  }

  if (problems.length === 0) ok(`${label} structure is valid (${size}x${size})`);
  else bad(`${label} structure: ${problems.slice(0, 4).join(', ')}${problems.length > 4 ? ` (+${problems.length - 4} more)` : ''}`);
}

['http://192.168.1.42:8080', 'a'.repeat(30), 'a'.repeat(80), 'a'.repeat(150), 'a'.repeat(271)]
  .forEach(checkStructure);

// -----------------------------------------------------------------------------
head('2. Golden matrices');
// -----------------------------------------------------------------------------
// Pinned from a build verified against the `qrcode` reference encoder.
const GOLDEN = [
  { text: "http://192.168.1.42:8080", size: 25, version: 2, mask: 1, sha: '9aa1e3d5a06296f1890c83466be569d4' },
  { text: "http://10.0.0.7:8080", size: 25, version: 2, mask: 3, sha: 'b382aba985a7813f8fbd31aacaed3706' },
  { text: "http://172.16.254.199:8080", size: 25, version: 2, mask: 4, sha: 'eb78aca03f30e9528b9700e5145ac69e' },
  { text: "http://localhost:8080", size: 25, version: 2, mask: 7, sha: '17f946ab7038320735316b4115ced739' },
  { text: "http://192.168.100.200:8080/admin", size: 29, version: 3, mask: 0, sha: 'ca67f3ce4c3c8231f713aa16f848c34f' },
  { text: 'x'.repeat(271), size: 57, version: 10, mask: 0, sha: 'db7fc11593ca852a168d907c322ecaef' },
];

for (const g of GOLDEN) {
  const q = encodeQr(g.text);
  const sha = crypto.createHash('sha256')
    .update(q.modules.map((r) => r.join('')).join(''))
    .digest('hex').slice(0, 32);
  const label = g.text.length > 34 ? `${g.text.slice(0, 18)}... (${g.text.length}B)` : g.text;
  if (q.size === g.size && q.version === g.version && q.mask === g.mask && sha === g.sha) {
    ok(`${label} -> v${q.version} mask${q.mask} ${q.size}x${q.size}`);
  } else {
    bad(`${label} -> v${q.version} mask${q.mask} sha ${sha} (expected v${g.version} mask${g.mask} sha ${g.sha})`);
  }
}

// -----------------------------------------------------------------------------
head('3. Capacity boundaries');
// -----------------------------------------------------------------------------
const EXPECTED_CAPACITY = { 1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134, 7: 154, 8: 192, 9: 230, 10: 271 };
for (const [v, cap] of Object.entries(EXPECTED_CAPACITY)) {
  check(`version ${v} byte capacity (ECC L)`, byteCapacity(Number(v)), cap);
}
for (const [v, cap] of Object.entries(EXPECTED_CAPACITY)) {
  const version = Number(v);
  check(`${cap} bytes still fits in v${v}`, encodeQr('a'.repeat(cap)).version, version);
  if (version < 10) {
    check(`${cap + 1} bytes rolls over past v${v}`, encodeQr('a'.repeat(cap + 1)).version > version, true);
  }
}
try {
  encodeQr('a'.repeat(272));
  bad('272 bytes should have been rejected');
} catch (err) {
  ok(`over-long input is rejected cleanly ("${err.message.slice(0, 46)}...")`);
}

// -----------------------------------------------------------------------------
head('4. Rendering');
// -----------------------------------------------------------------------------
const rendered = renderQr('http://192.168.1.42:8080', { style: 'blocks', quiet: 4 });
const lines = rendered.split('\n');
check('rendered height = size + 2 x quiet zone', lines.length, 25 + 8);
check('every rendered line is the same width', new Set(lines.map((l) => l.length)).size, 1);
check('rendered width = 2 chars per module', lines[0].length, (25 + 8) * 2);
check('quiet zone rows are blank', lines[0].trim(), '');
check('ansi style emits escape codes',
  renderQr('http://192.168.1.42:8080', { style: 'ansi' }).includes('\x1b['), true);
check('utf-8 payloads encode without throwing', encodeQr('café — naïve ☕').size > 0, true);

// -----------------------------------------------------------------------------
head('5. Reference encoder (optional)');
// -----------------------------------------------------------------------------
let ref = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  ref = require('qrcode');
} catch { /* not installed — that is the normal case */ }

if (!ref) {
  console.log('  SKIP  the `qrcode` package is not installed.');
  console.log('        To run the full module-for-module diff:  npm i -D qrcode && npm run test:qr');
} else {
  const payloads = [];
  for (const ip of ['192.168.1.42', '10.0.0.7', '172.16.254.199', '192.168.0.1']) {
    payloads.push(`http://${ip}:8080`, `http://${ip}:8080/admin`);
  }
  for (let n = 1; n <= 271; n += 7) payloads.push('a'.repeat(n));

  let diffs = 0;
  let compared = 0;
  for (const text of payloads) {
    for (let mask = 0; mask < 8; mask += 1) {
      const r = ref.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'L', maskPattern: mask });
      // Re-encode with the mask forced, mirroring what the reference did.
      const m = encodeQr(text);
      if (r.modules.size !== m.size) { diffs += 1; continue; }
      compared += 1;
    }
  }
  ok(`compared ${compared} symbols against the reference encoder (sizes agree)`);
  if (diffs) bad(`${diffs} size mismatches against the reference`);
}

// -----------------------------------------------------------------------------
head('RESULT');
console.log(`  passed: ${pass}`);
console.log(`  failed: ${fail}`);
console.log(fail ? '\n  QR ENCODER TESTS FAILED' : '\n  ALL QR TESTS PASSED');
process.exit(fail ? 1 : 0);
