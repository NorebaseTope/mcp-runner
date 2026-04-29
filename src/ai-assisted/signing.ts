// Ed25519 ephemeral keypair management for AI-Assisted mode.
// The private key is kept in memory only — never written to disk.
// The public key is sent to the server as part of session creation;
// the server issues a session certificate binding the public key to the session.
//
// ---------------------------------------------------------------------------
// Canonicalization contract — MUST be kept in sync with server-side ingest
// ---------------------------------------------------------------------------
//
// selfHash / prevEventHash are computed as: sha256Hex(JSON.stringify(event))
// where `event` is the full event object including the `signature` field.
//
// JSONL serialization: each event is written as JSON.stringify(event) + "\n".
// When computing prevEventHash from a stored JSONL line, the line is trimmed
// with String.trimEnd() before hashing — producing the identical sha256 as
// sha256Hex(JSON.stringify(event)) because trimEnd only removes the trailing
// newline and JSON.stringify never adds trailing whitespace.
//
// IMPORTANT: both the runner and the server rely on `JSON.stringify` producing
// the same field-order output for the same object. This works because:
//   1. The runner passes the exact in-memory object to both JSON.stringify and
//      the JSONL writer in the same tick.
//   2. The server re-serializes the parsed event with JSON.stringify, which
//      preserves insertion order (V8/Node guarantee for non-integer keys).
// If field order ever diverges (e.g., schema transformation, sorting), the
// hash-chain tests in non-interference.test.ts will catch it immediately.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export interface RunnerKeyPair {
  publicKeyBase64Url: string;
  // Opaque handle — callers should only use this via signEvent()
  _privateKey: import("node:crypto").KeyObject;
}

// Generate a fresh ephemeral Ed25519 keypair. Call once per AI-Assisted session.
export function generateEphemeralKeyPair(): RunnerKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  // Strip the 12-byte SPKI header to get the raw 32-byte key
  const rawPub = pubDer.slice(12);
  const publicKeyBase64Url = rawPub.toString("base64url");
  return { publicKeyBase64Url, _privateKey: privateKey };
}

// Sign arbitrary data with the runner's private key.
// Returns a base64url-encoded Ed25519 signature.
export function signData(data: Buffer | string, kp: RunnerKeyPair): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  const sig = sign(null, buf, kp._privateKey);
  return sig.toString("base64url");
}

// Verify a signature using a base64url-encoded public key.
// Returns true when the signature is valid.
export function verifySignature(
  data: Buffer | string,
  signatureBase64Url: string,
  publicKeyBase64Url: string,
): boolean {
  try {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    // Rebuild the SPKI DER: 12-byte header + 32-byte raw public key
    const rawPub = Buffer.from(publicKeyBase64Url, "base64url");
    // Ed25519 SPKI header (ASN.1 DER): sequence(sequence(OID 1.3.101.112), bitstring)
    const spkiHeader = Buffer.from(
      "302a300506032b6570032100",
      "hex",
    );
    const spkiDer = Buffer.concat([spkiHeader, rawPub]);
    const pubKey = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    const sig = Buffer.from(signatureBase64Url, "base64url");
    return verify(null, buf, pubKey, sig);
  } catch {
    return false;
  }
}

// Compute SHA-256 hash of arbitrary data. Returns hex string.
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data) : data)
    .digest("hex");
}

// Canonical bytes for an event (everything except the signature field).
// Both runner and server must produce identical bytes for the same event.
export function canonicalEventBytes(eventWithoutSignature: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(eventWithoutSignature));
}
