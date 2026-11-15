/** Standalone ISO/IEC 18004 QR Code encoder (Byte mode, EC Level L, Versions 1..10) + SVG renderer. */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    EXP[i + 255] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    const factor = EXP[i];
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], factor);
    }
    g = next;
  }
  return g;
}

function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) {
      res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

// Version specs for EC Level L: [totalData, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data, alignCenters]
const VERSIONS = [
  null,
  [19, 7, 1, 19, 0, 0, []],
  [34, 10, 1, 34, 0, 0, [6, 18]],
  [55, 15, 1, 55, 0, 0, [6, 22]],
  [80, 20, 1, 80, 0, 0, [6, 26]],
  [108, 26, 1, 108, 0, 0, [6, 30]],
  [136, 18, 2, 68, 0, 0, [6, 34]],
  [156, 20, 2, 78, 0, 0, [6, 22, 38]],
  [194, 24, 2, 97, 0, 0, [6, 24, 42]],
  [232, 30, 2, 116, 0, 0, [6, 26, 46]],
  [274, 18, 2, 68, 2, 69, [6, 28, 50]],
];

const bitLen = (n) => 32 - Math.clz32(n);

function bchFormat(mask) {
  const data = (0b01 << 3) | mask; // EC Level L = 01
  let rem = data << 10;
  while (bitLen(rem) >= 11) rem ^= 0x537 << (bitLen(rem) - 11);
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersion(ver) {
  let rem = ver << 12;
  while (bitLen(rem) >= 13) rem ^= 0x1f25 << (bitLen(rem) - 13);
  return (ver << 12) | rem;
}

export function makeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let ver = 1;
  while (ver < VERSIONS.length) {
    const cap = VERSIONS[ver][0];
    const headerBits = 4 + (ver >= 10 ? 16 : 8);
    if (headerBits + bytes.length * 8 <= cap * 8) break;
    ver++;
  }
  if (ver >= VERSIONS.length) ver = VERSIONS.length - 1;

  const [totalData, ecLen, g1B, g1D, g2B, g2D, align] = VERSIONS[ver];
  const bitBuf = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i--) bitBuf.push((val >>> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  const maxBytes = totalData - (ver >= 10 ? 3 : 2);
  const sliced = bytes.subarray(0, Math.max(0, maxBytes));
  pushBits(sliced.length, ver >= 10 ? 16 : 8);
  for (const b of sliced) pushBits(b, 8);
  pushBits(0, Math.min(4, totalData * 8 - bitBuf.length));
  while (bitBuf.length % 8 !== 0) bitBuf.push(0);

  const dataWords = new Uint8Array(totalData);
  for (let i = 0; i < bitBuf.length / 8; i++) {
    let w = 0;
    for (let b = 0; b < 8; b++) w = (w << 1) | bitBuf[i * 8 + b];
    dataWords[i] = w;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bitBuf.length / 8, p = 0; i < totalData; i++, p++) {
    dataWords[i] = padBytes[p & 1];
  }

  // Split into RS blocks & compute EC
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1B; i++) {
    const d = dataWords.subarray(offset, offset + g1D);
    blocks.push({ d, ec: rsRemainder(d, ecLen) });
    offset += g1D;
  }
  for (let i = 0; i < g2B; i++) {
    const d = dataWords.subarray(offset, offset + g2D);
    blocks.push({ d, ec: rsRemainder(d, ecLen) });
    offset += g2D;
  }

  const stream = [];
  const maxD = Math.max(g1D, g2D);
  for (let i = 0; i < maxD; i++) {
    for (const blk of blocks) if (i < blk.d.length) stream.push(blk.d[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of blocks) stream.push(blk.ec[i]);
  }

  const size = ver * 4 + 17;
  const mods = Array.from({ length: size }, () => new Uint8Array(size));
  const fnMask = Array.from({ length: size }, () => new Uint8Array(size));

  const setFn = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mods[r][c] = dark ? 1 : 0;
    fnMask[r][c] = 1;
  };

  const drawFinder = (tr, tc) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = tr + dr;
        const c = tc + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const border = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const outer = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFn(r, c, !border && (outer || core));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment
  for (const r0 of align) {
    for (const c0 of align) {
      if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFn(r0 + dr, c0 + dc, dark);
        }
      }
    }
  }

  // Dark module & reserve format info slots
  setFn(4 * ver + 9, 8, true);
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      fnMask[8][i] = 1;
      fnMask[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    fnMask[8][size - 1 - i] = 1;
    fnMask[size - 1 - i][8] = 1;
  }

  // Version info (v >= 7)
  if (ver >= 7) {
    const vi = bchVersion(ver);
    for (let i = 0; i < 18; i++) {
      const bit = Boolean((vi >>> i) & 1);
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  // Place data bits zig-zag
  let bitIdx = 0;
  let dir = -1;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = dir === -1 ? size - 1 - step : step;
      for (let cOff = 0; cOff < 2; cOff++) {
        const c = right - cOff;
        if (!fnMask[r][c]) {
          const byteIdx = bitIdx >>> 3;
          const bit = byteIdx < stream.length ? (stream[byteIdx] >>> (7 - (bitIdx & 7))) & 1 : 0;
          mods[r][c] = bit;
          bitIdx++;
        }
      }
    }
    dir = -dir;
  }

  const maskFn = (m, r, c) => {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  // Pick lowest-penalty mask (mask 0..7)
  let bestMask = 0;
  let bestPenalty = Infinity;
  const writeFormat = (grid, m) => {
    const f = bchFormat(m);
    for (let i = 0; i < 6; i++) {
      const bit = (f >>> i) & 1;
      grid[i][8] = bit;
      grid[8][size - 1 - i] = bit;
    }
    const b6 = (f >>> 6) & 1;
    const b7 = (f >>> 7) & 1;
    const b8 = (f >>> 8) & 1;
    grid[7][8] = b6;
    grid[8][size - 7] = b6;
    grid[8][8] = b7;
    grid[8][size - 8] = b7;
    grid[8][7] = b8;
    grid[size - 7][8] = b8;
    for (let i = 9; i < 15; i++) {
      const bit = (f >>> i) & 1;
      grid[8][14 - i] = bit;
      grid[size - 15 + i][8] = bit;
    }
  };

  for (let m = 0; m < 8; m++) {
    const testGrid = mods.map((row, r) => row.map((v, c) => (fnMask[r][c] ? v : v ^ (maskFn(m, r, c) ? 1 : 0))));
    writeFormat(testGrid, m);
    let pen = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (testGrid[r][c] === testGrid[r][c - 1]) run++;
        else { if (run >= 5) pen += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) pen += 3 + (run - 5);
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (testGrid[r][c] === testGrid[r - 1][c]) run++;
        else { if (run >= 5) pen += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) pen += 3 + (run - 5);
    }
    if (pen < bestPenalty) {
      bestPenalty = pen;
      bestMask = m;
    }
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fnMask[r][c] && maskFn(bestMask, r, c)) mods[r][c] ^= 1;
    }
  }
  writeFormat(mods, bestMask);

  return {
    size,
    get: (r, c) => Boolean(mods[r]?.[c]),
  };
}

/** Render a razor-sharp single-path SVG QR code string with quiet zone. */
export function renderQrSvg(text, px = 220) {
  const mat = makeQrMatrix(text);
  const pad = 2;
  const total = mat.size + pad * 2;
  let d = '';
  for (let r = 0; r < mat.size; r++) {
    for (let c = 0; c < mat.size; c++) {
      if (mat.get(r, c)) d += `M${c + pad},${r + pad}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" rx="2" fill="#ffffff"/><path d="${d}" fill="#0b0f19"/></svg>`;
}
