/**
 * DigiQuiz dev bundle — tools/banner.js
 * =============================================================================
 * Prints the "open this on your phone" banner: the LAN URL, an ASCII QR code of
 * it, and the demo credentials. No dependencies, no network calls.
 *
 *   node tools/banner.js [--port 8080] [--ip 192.168.1.42] [--no-qr] [--blocks]
 * =============================================================================
 */

'use strict';

const { detectLanIp, listCandidates } = require('./lanip');
const { renderQr } = require('./qr');

function parseArgs(argv) {
  const args = { port: process.env.WEB_PORT || 8080, ip: null, qr: true, style: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--port') { args.port = argv[i + 1]; i += 1; }
    else if (argv[i] === '--ip') { args.ip = argv[i + 1]; i += 1; }
    else if (argv[i] === '--no-qr') args.qr = false;
    else if (argv[i] === '--blocks') args.style = 'blocks';
  }
  return args;
}

function printBanner({ port, ip, qr, style } = {}) {
  const thePort = port || process.env.WEB_PORT || 8080;

  // start.ps1 detects the address with Get-NetIPAddress (which knows about
  // Hyper-V, WSL and Docker Desktop adapters in a way os.networkInterfaces()
  // does not) and passes its answer down through this variable. Node's own
  // detection is the fallback.
  const lanIp = ip || process.env.DIGIQUIZ_LAN_IP || detectLanIp();

  // Windows PowerShell 5.1 without VT enabled cannot render ANSI colour, so
  // start.ps1 asks for block characters instead.
  const theStyle = style || process.env.DIGIQUIZ_QR_STYLE || undefined;
  const url = lanIp ? `http://${lanIp}:${thePort}` : null;
  const localUrl = `http://localhost:${thePort}`;

  // High-contrast bar: black text on a white background. Forced with ANSI so
  // it reads correctly whatever colour scheme the terminal uses, and so it
  // survives being photographed off a laptop screen.
  const INVERT = '\x1b[30;47m';
  const RESET = '\x1b[0m';
  const useColour = !process.env.NO_COLOR;
  const bigUrl = (u) => (useColour ? `${INVERT}   ${u}   ${RESET}` : `>>>   ${u}   <<<`);

  const line = '='.repeat(66);
  console.log('');
  console.log('');
  console.log(`  ${line}`);
  console.log('');
  console.log('   SERVERS ARE READY - OPEN THIS ON YOUR PHONE');
  console.log('');
  console.log(`     ${bigUrl(url || localUrl)}`);
  console.log('');
  console.log('   (phone and computer must be on the same WiFi)');
  console.log('');
  console.log(`  ${line}`);
  console.log('');
  console.log(`  On this computer:     ${localUrl}`);

  if (url) {
    console.log(`  From another device:  ${url}`);
    if (qr) {
      console.log('');
      try {
        console.log(renderQr(url, { style: theStyle, quiet: 3 }));
      } catch (err) {
        console.log(`  [QR unavailable: ${err.message}]`);
      }
      console.log('  Point your phone camera at the square above, or just type the URL.');
    }
  } else {
    console.log('');
    console.log('  No LAN address found — is WiFi switched on?');
    console.log('  The app still works on this computer at the URL above.');
  }

  console.log('');
  console.log('  Sign in with:');
  console.log('    student_demo / Passw0rd!     (student)');
  console.log('    ali          / Passw0rd!     (student)');
  console.log('    admin        / Admin123!     (admin — unlocks /admin)');
  console.log('');

  const others = listCandidates().slice(1);
  if (others.length) {
    console.log('  If the phone cannot connect, try one of these instead:');
    others.slice(0, 4).forEach((c) => {
      console.log(`    http://${c.address}:${thePort}   (${c.name})`);
    });
    console.log('');
  }

  console.log('  Press Ctrl+C to stop.');
  console.log('');
  return url;
}

module.exports = { printBanner };

if (require.main === module) {
  printBanner(parseArgs(process.argv));
}
