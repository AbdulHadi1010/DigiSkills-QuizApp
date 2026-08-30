/**
 * DigiQuiz dev bundle — tools/qr.js
 * =============================================================================
 * A tiny, self-contained QR Code encoder. Vendored on purpose:
 *
 *   - no npm install (it must work before `npm install` has ever been run)
 *   - no runtime network calls (it renders offline, on a laptop with no WiFi
 *     uplink, which is exactly the situation this bundle is for)
 *   - no native modules
 *
 * Scope: byte mode, error-correction level L, versions 1-10 (up to 271 bytes).
 * That is far more than a `http://192.168.x.x:8080` URL needs, and keeping the
 * scope small keeps the file auditable.
 *
 * Implements ISO/IEC 18004: GF(256) Reed-Solomon ECC, block interleaving,
 * function-pattern placement, all 8 data masks with the standard penalty
 * scoring, BCH format information and (for v>=7) version information.
 *
 *   const { renderQr } = require('./qr');
 *   console.log(renderQr('http://192.168.1.42:8080'));
 * =============================================================================
 */

'use strict';

// -----------------------------------------------------------------------------
// GF(256) arithmetic — primitive polynomial 0x11D
// -----------------------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) out[i + j] ^= gmul(a[i], b[j]);
  }
  return out;
}

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i += 1) g = polyMul(g, [1, EXP[i]]);
  return g;
}

/** Return the `ecLen` error-correction codewords for `data`. */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i += 1) res[i] = data[i];
  for (let i = 0; i < data.length; i += 1) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) res[i + j] ^= gmul(gen[j], factor);
  }
  return res.slice(data.length);
}

// -----------------------------------------------------------------------------
// Version tables — error-correction level L only
//   [ totalDataCodewords, ecCodewordsPerBlock, g1Blocks, g1Data, g2Blocks, g2Data ]
// -----------------------------------------------------------------------------
const VERSIONS_L = {
  1:  [19,   7, 1, 19, 0, 0],
  2:  [34,  10, 1, 34, 0, 0],
  3:  [55,  15, 1, 55, 0, 0],
  4:  [80,  20, 1, 80, 0, 0],
  5:  [108, 26, 1, 108, 0, 0],
  6:  [136, 18, 2, 68, 0, 0],
  7:  [156, 20, 2, 78, 0, 0],
  8:  [194, 24, 2, 97, 0, 0],
  9:  [232, 30, 2, 116, 0, 0],
  10: [274, 18, 2, 68, 2, 69],
};

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** Remainder bits appended after the interleaved codeword stream. */
function remainderBits(version) {
  if (version === 1) return 0;
  if (version <= 6) return 7;
  return 0; // versions 7-13
}

const charCountBits = (version) => (version < 10 ? 8 : 16);

function byteCapacity(version) {
  const dataCw = VERSIONS_L[version][0];
  return Math.floor((dataCw * 8 - 4 - charCountBits(version)) / 8);
}

function chooseVersion(byteLength) {
  for (let v = 1; v <= 10; v += 1) {
    if (byteLength <= byteCapacity(v)) return v;
  }
  throw new Error(
    `qr.js: ${byteLength} bytes is too long — this encoder supports up to ` +
    `${byteCapacity(10)} bytes (versions 1-10, ECC level L).`
  );
}

// -----------------------------------------------------------------------------
// Bit buffer
// -----------------------------------------------------------------------------
class BitBuffer {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
  toCodewords() {
    const bits = this.bits.slice();
    while (bits.length % 8 !== 0) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
      out.push(byte);
    }
    return out;
  }
}

// -----------------------------------------------------------------------------
// Data encoding: mode + count + payload + terminator + pad
// -----------------------------------------------------------------------------
function encodeData(text, version) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const buf = new BitBuffer();

  buf.put(0b0100, 4);                              // byte mode
  buf.put(bytes.length, charCountBits(version));   // character count
  bytes.forEach((b) => buf.put(b, 8));

  const totalDataBits = VERSIONS_L[version][0] * 8;

  // Terminator: up to four 0 bits
  const terminator = Math.min(4, totalDataBits - buf.length);
  if (terminator > 0) buf.put(0, terminator);

  const codewords = buf.toCodewords();

  // Pad alternately with 0xEC / 0x11 up to capacity
  const capacity = VERSIONS_L[version][0];
  const PAD = [0xec, 0x11];
  let p = 0;
  while (codewords.length < capacity) {
    codewords.push(PAD[p % 2]);
    p += 1;
  }
  return codewords;
}

// -----------------------------------------------------------------------------
// Split into blocks, compute ECC, interleave
// -----------------------------------------------------------------------------
function buildCodewordStream(dataCodewords, version) {
  const [, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = VERSIONS_L[version];

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  const pushBlocks = (count, size) => {
    for (let i = 0; i < count; i += 1) {
      const block = dataCodewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecPerBlock));
    }
  };
  pushBlocks(g1Blocks, g1Data);
  pushBlocks(g2Blocks, g2Data);

  const stream = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) stream.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) if (i < block.length) stream.push(block[i]);
  }
  return stream;
}

// -----------------------------------------------------------------------------
// Matrix construction
// -----------------------------------------------------------------------------
function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, dark) => {
    modules[r][c] = dark ? 1 : 0;
    reserved[r][c] = true;
  };

  // Finder patterns + separators
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, inRing);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centres = ALIGNMENT[version];
  for (const r of centres) {
    for (const c of centres) {
      // skip the three that would collide with the finder patterns
      const nearFinder =
        (r <= 8 && c <= 8) ||
        (r <= 8 && c >= size - 9) ||
        (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(r + dr, c + dc, dark);
        }
      }
    }
  }

  // Dark module
  set(size - 8, 8, true);

  // Reserve format-information areas
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  // Reserve version-information areas (v >= 7)
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }

  return { size, modules, reserved };
}

/** Zig-zag data placement, right to left, skipping the vertical timing column. */
function placeData(matrix, stream, version) {
  const { size, modules, reserved } = matrix;
  const bits = [];
  stream.forEach((byte) => {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  });
  for (let i = 0; i < remainderBits(version); i += 1) bits.push(0);

  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    const col = right === 6 ? 5 : right; // column 6 is the timing pattern
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k += 1) {
        const c = col - k;
        if (reserved[row][c]) continue;
        modules[row][c] = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
    if (right === 6) right -= 1; // we already consumed column 5 as part of this pair
  }
}

const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(matrix, maskIndex) {
  const { size, modules, reserved } = matrix;
  const fn = MASK_FN[maskIndex];
  const out = modules.map((row) => row.slice());
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (reserved[r][c]) continue;
      if (fn(r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

/** The four standard penalty rules. Lower is better. */
function penalty(grid) {
  const size = grid.length;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row/column
  const runScore = (get) => {
    let total = 0;
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        if (get(a, b) === get(a, b - 1)) {
          run += 1;
        } else {
          if (run >= 5) total += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) total += 3 + (run - 5);
    }
    return total;
  };
  score += runScore((a, b) => grid[a][b]);
  score += runScore((a, b) => grid[b][a]);

  // Rule 2: 2x2 blocks of the same colour
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns with four light modules either side
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, a, b) => {
    const seq = [];
    for (let k = 0; k < 11; k += 1) seq.push(get(a, b + k));
    const eq = (p) => p.every((v, i) => v === seq[i]);
    return eq(P1) || eq(P2);
  };
  for (let a = 0; a < size; a += 1) {
    for (let b = 0; b + 11 <= size; b += 1) {
      if (matches((x, y) => grid[x][y], a, b)) score += 40;
      if (matches((x, y) => grid[y][x], a, b)) score += 40;
    }
  }

  // Rule 4: deviation from a 50/50 light/dark balance.
  // ISO/IEC 18004 defines this as floor(|percent - 50| / 5) * 10. Some popular
  // libraries use the variant |ceil(percent/5) - 10| * 10, which occasionally
  // selects a different mask. Either is a legal symbol — masking is a free
  // choice that only tunes readability — but it means our chosen mask can
  // differ from another encoder's on roughly 3% of random payloads. It never
  // differed on any of the LAN-URL shapes this tool actually renders. See
  // qr.test.js, which pins correctness by forcing each mask in turn.
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) dark += grid[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** BCH(15,5) format information for ECC level L and the chosen mask. */
function formatBits(maskIndex) {
  const ECC_L = 0b01;
  const data = (ECC_L << 3) | maskIndex;
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (value & (1 << (i + 10))) value ^= 0b10100110111 << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/**
 * BCH(18,6) version information, versions 7 and up.
 * Generator polynomial G18 = 0b1111100100101 (0x1F25), 13 bits.
 */
function versionBits(version) {
  let value = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if (value & (1 << (i + 12))) value ^= 0b1111100100101 << i;
  }
  return (version << 12) | value;
}

/**
 * Write both copies of the 15-bit format information.
 *
 * Bit 0 is the LSB. Per ISO/IEC 18004 the LSB sits at the OUTER end of each
 * strip — (0,8) and (8,size-1) — and the bits run inward. Getting this order
 * backwards still produces a plausible-looking symbol that no scanner can read,
 * so this placement is verified module-for-module against a reference encoder
 * in tools/qr.test.js.
 */
function writeFormatInfo(grid, size, maskIndex) {
  const bits = formatBits(maskIndex);

  for (let i = 0; i < 15; i += 1) {
    const b = (bits >>> i) & 1;

    // Vertical strip: down the left of the top-left finder, then up from the
    // bottom-left finder.
    if (i < 6) grid[i][8] = b;
    else if (i < 8) grid[i + 1][8] = b;      // skip the horizontal timing row
    else grid[size - 15 + i][8] = b;

    // Horizontal strip: in from the top-right finder, then along the top-left.
    if (i < 8) grid[8][size - 1 - i] = b;
    else if (i === 8) grid[8][7] = b;        // skip the vertical timing column
    else grid[8][14 - i] = b;
  }

  grid[size - 8][8] = 1; // dark module, always
}

function writeVersionInfo(grid, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const b = (bits >>> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    grid[r][size - 11 + c] = b;
    grid[size - 11 + c][r] = b;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Encode `text` and return { size, modules } where modules[row][col] is 0 or 1.
 * Exposed separately from rendering so it can be diffed against a reference
 * encoder in the test suite.
 */
function encodeQr(text) {
  const byteLength = Buffer.byteLength(text, 'utf8');
  const version = chooseVersion(byteLength);

  const dataCodewords = encodeData(text, version);
  const stream = buildCodewordStream(dataCodewords, version);

  const matrix = createMatrix(version);
  placeData(matrix, stream, version);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = applyMask(matrix, mask);
    writeFormatInfo(grid, matrix.size, mask);
    writeVersionInfo(grid, matrix.size, version);
    const score = penalty(grid);
    if (!best || score < best.score) best = { score, grid, mask };
  }

  return { size: matrix.size, version, mask: best.mask, modules: best.grid };
}

/**
 * Render a QR code as text.
 *
 * `style`:
 *   'ansi'   ANSI background colours — correct light/dark polarity on any
 *            terminal theme. Default when stdout is a TTY.
 *   'blocks' Unicode full blocks. Assumes a light terminal background.
 *
 * `quiet` is the quiet-zone width in modules; the spec asks for 4.
 */
function renderQr(text, opts = {}) {
  const { size, modules } = encodeQr(text);
  const quiet = opts.quiet === undefined ? 4 : opts.quiet;
  const style = opts.style || (process.stdout.isTTY && !process.env.NO_COLOR ? 'ansi' : 'blocks');

  const DARK = style === 'ansi' ? '\x1b[40m  \x1b[0m' : '██';
  const LIGHT = style === 'ansi' ? '\x1b[47m  \x1b[0m' : '  ';

  const lines = [];
  const blankRow = LIGHT.repeat(size + quiet * 2);
  for (let i = 0; i < quiet; i += 1) lines.push(blankRow);
  for (let r = 0; r < size; r += 1) {
    let line = LIGHT.repeat(quiet);
    for (let c = 0; c < size; c += 1) line += modules[r][c] ? DARK : LIGHT;
    line += LIGHT.repeat(quiet);
    lines.push(line);
  }
  for (let i = 0; i < quiet; i += 1) lines.push(blankRow);
  return lines.join('\n');
}

module.exports = { encodeQr, renderQr, byteCapacity };

// CLI: node tools/qr.js "http://192.168.1.42:8080"
if (require.main === module) {
  const text = process.argv[2] || 'http://localhost:8080';
  const style = process.argv.includes('--blocks') ? 'blocks' : undefined;
  console.log(renderQr(text, { style }));
  console.log(text);
}
