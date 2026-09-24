const crypto = require("crypto");

// Secret used to sign challenges. Generated once at process start, so a
// challenge only remains valid for the lifetime of this server process
// (and within its short expiry window below) - no database or session
// store needed, no third-party service involved.
const SECRET = process.env.CAPTCHA_SECRET || crypto.randomBytes(32).toString("hex");

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Proof-of-work difficulty: number of leading zero BITS a solver must
// find in sha256(token + ":" + nonce). Each extra bit roughly doubles the
// average number of hashes needed. 18 bits (~262k hashes on average)
// takes a modern browser tab a fraction of a second to a couple of
// seconds, while making bulk/automated submission cost real, unavoidable
// CPU time per attempt - the cost scales linearly with how many times a
// bot resubmits, and can't be precomputed or cached, since each
// challenge's token is freshly random and signed. Tune via env var if a
// given deployment needs it harder or easier.
const POW_DIFFICULTY_BITS = Number(process.env.CAPTCHA_POW_BITS || 18);

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

/**
 * Creates a small arithmetic challenge ("what is 4 + 7?") along with a
 * signed, tamper-proof token that encodes the expected answer, an expiry
 * time, and the proof-of-work difficulty the client must satisfy. The
 * token is opaque to the browser (base64) and doesn't require
 * server-side session storage.
 */
function createChallenge() {
  const a = Math.floor(Math.random() * 8) + 1;
  const b = Math.floor(Math.random() * 8) + 1;
  const answer = a + b;
  const expires = Date.now() + CHALLENGE_TTL_MS;
  const payload = `${answer}:${expires}:${POW_DIFFICULTY_BITS}`;
  const token = Buffer.from(`${payload}:${sign(payload)}`).toString("base64");
  return { a, b, token, difficulty: POW_DIFFICULTY_BITS };
}

// Counts leading zero bits in a hex digest string.
function leadingZeroBits(hex) {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(nibble) - 28; // leading zero bits within this 4-bit nibble
    break;
  }
  return bits;
}

function verifyProofOfWork(token, nonce, difficulty) {
  if (!nonce || typeof nonce !== "string" || nonce.length > 128) return false;
  const digest = crypto.createHash("sha256").update(`${token}:${nonce}`).digest("hex");
  return leadingZeroBits(digest) >= difficulty;
}

/**
 * Verifies a submitted answer against its challenge token: checks the
 * HMAC signature (so the token wasn't forged/edited), that it hasn't
 * expired, that the arithmetic answer matches, AND that the client
 * supplied a nonce proving it burned the required amount of compute
 * against this exact token (proof of work).
 */
function verifyChallenge(token, submittedAnswer, nonce) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(String(token), "base64").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 4) return false;
    const [answer, expires, difficulty, signature] = parts;
    const payload = `${answer}:${expires}:${difficulty}`;
    const expectedSignature = sign(payload);

    const sigBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    if (sigBuffer.length !== expectedBuffer.length) return false;
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return false;

    if (Date.now() > Number(expires)) return false;
    if (Number(submittedAnswer) !== Number(answer)) return false;

    // Fail closed: no valid proof of work, no pass - regardless of how
    // correct the arithmetic answer is.
    if (!verifyProofOfWork(token, nonce, Number(difficulty))) return false;

    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { createChallenge, verifyChallenge };
