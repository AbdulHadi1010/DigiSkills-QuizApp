/**
 * DigiQuiz dev bundle — tools/lanip.js
 * =============================================================================
 * Work out which IPv4 address a phone on the same WiFi should be pointed at.
 *
 * Uses only os.networkInterfaces() — no network calls, no DNS, no STUN, nothing
 * that needs an internet uplink. A laptop sharing its own hotspot with no WAN
 * still gets the right answer.
 *
 * The interesting part is ranking, because a developer laptop usually has
 * several addresses and only one of them is reachable from a phone:
 *   - loopback (127.x)             never
 *   - link-local (169.254.x)       "no DHCP" — a phone will not reach it
 *   - Docker / WSL / Hyper-V / VM  bridges: real addresses, wrong network
 *   - the actual Wi-Fi adapter     <- what we want
 *
 * Picking wrong is the single most common reason "it works on my laptop but the
 * phone times out", so the ranking below is deliberate rather than "first hit".
 * =============================================================================
 */

'use strict';

const os = require('os');

/** Interface names that are almost never the one a phone can reach. */
const VIRTUAL_PATTERNS = [
  /^lo/i, /loopback/i,
  /^docker/i, /^br-/i, /^veth/i, /^virbr/i,
  /vmnet/i, /vboxnet/i, /^utun/i, /^tun/i, /^tap/i,
  /hyper-v/i, /^vEthernet/i, /\(WSL/i, /WSL/i,
  /bluetooth/i, /^awdl/i, /^llw/i, /^ap\d/i,
  /vpn/i, /tailscale/i, /zerotier/i,
];

/** Interface names that are very likely the real WiFi/Ethernet adapter. */
const PREFERRED_PATTERNS = [
  /wi-?fi/i, /wlan/i, /wlp/i, /^en0$/i, /wireless/i,
  /^eth\d/i, /^enp/i, /ethernet/i,
];

const PRIVATE_RANGES = [
  { test: (o) => o[0] === 192 && o[1] === 168, score: 100, label: '192.168/16' },
  { test: (o) => o[0] === 10, score: 90, label: '10/8' },
  { test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31, score: 80, label: '172.16/12' },
  { test: (o) => o[0] === 169 && o[1] === 254, score: -50, label: 'link-local (no DHCP)' },
];

function scoreCandidate(name, address) {
  const octets = address.split('.').map(Number);
  let score = 0;
  let rangeLabel = 'public/other';

  for (const r of PRIVATE_RANGES) {
    if (r.test(octets)) { score += r.score; rangeLabel = r.label; break; }
  }

  if (PREFERRED_PATTERNS.some((p) => p.test(name))) score += 40;
  if (VIRTUAL_PATTERNS.some((p) => p.test(name))) score -= 120;

  // Docker's default bridge subnet, whatever the interface happens to be called
  if (octets[0] === 172 && octets[1] >= 17 && octets[1] <= 31) score -= 60;

  return { name, address, score, rangeLabel };
}

/** All non-internal IPv4 candidates, best first. */
function listCandidates() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : `IPv${a.family}`;
      if (family !== 'IPv4') continue;
      if (a.internal) continue;
      out.push(scoreCandidate(name, a.address));
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * The single best address to hand to a phone, or null if there is none
 * (laptop offline / WiFi off). Callers should fall back to localhost and say so.
 */
function detectLanIp() {
  const candidates = listCandidates();
  return candidates.length ? candidates[0].address : null;
}

module.exports = { detectLanIp, listCandidates };

// CLI: node tools/lanip.js
if (require.main === module) {
  const all = listCandidates();
  if (!all.length) {
    console.log('No LAN IPv4 address found — is WiFi on?');
    process.exit(1);
  }
  console.log('Candidate addresses, best first:\n');
  all.forEach((c, i) => {
    console.log(
      `  ${i === 0 ? '->' : '  '} ${c.address.padEnd(16)} ${String(c.name).padEnd(28)} ` +
      `score=${String(c.score).padStart(4)}  ${c.rangeLabel}`
    );
  });
  console.log(`\nChosen: ${all[0].address}`);
}
