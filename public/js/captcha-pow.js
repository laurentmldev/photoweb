// Proof-of-work solver for the human check (contact page, "Your Photos").
//
// Runs entirely in the browser: no library, no network calls, nothing
// leaves the page. It repeatedly hashes token + ":" + nonce with SHA-256
// until the hex digest has enough leading zero bits, then fills the
// hidden "nonce" field and enables the submit button. The server
// re-verifies the same hash server-side before accepting the form.
(function () {
  "use strict";

  // --- Minimal, self-contained SHA-256 (FIPS 180-4) -----------------
  // Written directly (no bundler/CDN dependency) so this file works
  // completely offline and so the tight mining loop below can call it
  // synchronously rather than paying per-call async overhead.
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // Encodes a JS string as UTF-8 bytes and SHA-256-pads it.
  function padMessage(bytes) {
    const bitLen = bytes.length * 8;
    const withOne = bytes.concat([0x80]);
    while (withOne.length % 64 !== 56) withOne.push(0);
    // 64-bit big-endian length in bits. We only ever hash short strings
    // here, so the high-order 32 bits are always zero.
    withOne.push(0, 0, 0, 0);
    withOne.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
    return withOne;
  }

  function sha256Hex(str) {
    const bytes = Array.from(new TextEncoder().encode(str));
    const padded = padMessage(bytes);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const w = new Array(64);
    for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
      for (let i = 0; i < 16; i++) {
        const o = chunkStart + i * 4;
        w[i] = (padded[o] << 24) | (padded[o + 1] << 16) | (padded[o + 2] << 8) | padded[o + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) | 0;

        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }

      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  function leadingZeroBits(hex) {
    let bits = 0;
    for (let i = 0; i < hex.length; i++) {
      const nibble = parseInt(hex[i], 16);
      if (nibble === 0) {
        bits += 4;
        continue;
      }
      bits += Math.clz32(nibble) - 28;
      break;
    }
    return bits;
  }

  // --- Wiring into the contact form ----------------------------------
  function initPow(form) {
    const token = form.dataset.powToken;
    const difficulty = Number(form.dataset.powDifficulty || 18);
    const nonceField = form.querySelector('input[name="nonce"]');
    const submitButton = form.querySelector('button[type="submit"]');
    const status = form.querySelector(".pow-status");

    if (!token || !nonceField || !submitButton) return;

    submitButton.disabled = true;
    if (status) status.textContent = "Verifying your browser (runs locally, no data sent)…";

    let counter = 0;
    const CHUNK = 4000; // hashes per tick, keeps the tab responsive

    function mineChunk() {
      for (let i = 0; i < CHUNK; i++) {
        const nonce = counter.toString(36);
        const hash = sha256Hex(`${token}:${nonce}`);
        if (leadingZeroBits(hash) >= difficulty) {
          nonceField.value = nonce;
          submitButton.disabled = false;
          if (status) status.textContent = "Verified - you can submit now.";
          return;
        }
        counter++;
      }
      // Yield back to the browser between chunks instead of blocking it.
      setTimeout(mineChunk, 0);
    }

    // Kick off on the next tick so the page paints first.
    setTimeout(mineChunk, 0);
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("form[data-pow-token]").forEach(initPow);
  });
})();
