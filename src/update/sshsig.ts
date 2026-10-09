// SSH signatures (`ssh-keygen -Y sign`), checked without ssh-keygen: OpenSSH's PROTOCOL.sshsig.
// A release's SHA256SUMS is signed with the release key; this is what tells an update it came from
// whoever holds that key, not merely from whoever could upload to the release.
import { createHash, createPublicKey, verify } from "node:crypto"

const MAGIC = Buffer.from("SSHSIG")

class Reader {
  private at = 0
  constructor(private b: Buffer) {}
  bytes(n: number): Buffer {
    if (this.at + n > this.b.length) throw new Error("truncated signature")
    const out = this.b.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
  done(): boolean {
    return this.at === this.b.length
  }
  u32(): number {
    return this.bytes(4).readUInt32BE(0)
  }
  string(): Buffer {
    return this.bytes(this.u32())
  }
}

const sshString = (b: Buffer | string) => {
  const body = typeof b === "string" ? Buffer.from(b) : b
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  return Buffer.concat([len, body])
}

/** The raw 32-byte ed25519 key of an `ssh-ed25519 AAAA… comment` line. */
export function ed25519Key(line: string): Buffer {
  const [type, b64] = line.trim().split(/\s+/)
  if (type !== "ssh-ed25519" || !b64) throw new Error(`not an ssh-ed25519 public key: ${line.slice(0, 40)}`)
  const r = new Reader(Buffer.from(b64, "base64"))
  if (r.string().toString() !== "ssh-ed25519") throw new Error("not an ssh-ed25519 public key")
  const key = r.string()
  if (key.length !== 32) throw new Error("bad ed25519 key length")
  return key
}

/** Whether `armored` is a valid signature of `message` in `namespace` by one of `keys`
 *  (ssh-ed25519 public key lines). Throws with the reason when it is not. */
export function verifySshSig(message: Uint8Array, armored: string, namespace: string, keys: string[]): void {
  // Exactly one armored block, nothing but base64 inside, nothing left over after the fields.
  const m = /^\s*-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\s]+?)\n-----END SSH SIGNATURE-----\s*$/.exec(armored.replace(/\r\n/g, "\n"))
  if (!m) throw new Error("not one armored SSH signature")
  const body = m[1]!.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error("the signature is not valid base64")
  const blob = Buffer.from(body, "base64")
  const r = new Reader(blob)
  if (!r.bytes(6).equals(MAGIC)) throw new Error("not an SSH signature")
  if (r.u32() !== 1) throw new Error("unknown SSH signature version")
  const pub = new Reader(r.string())
  if (pub.string().toString() !== "ssh-ed25519") throw new Error("the signature is not ed25519")
  const signer = pub.string()
  const ns = r.string().toString()
  const reserved = r.string()
  const hashAlg = r.string().toString()
  const sig = new Reader(r.string())
  if (sig.string().toString() !== "ssh-ed25519") throw new Error("the signature is not ed25519")
  const raw = sig.string()
  if (!r.done() || !pub.done() || !sig.done()) throw new Error("the signature has bytes it should not")

  if (ns !== namespace) throw new Error(`signed for "${ns}", not "${namespace}"`)
  if (hashAlg !== "sha512" && hashAlg !== "sha256") throw new Error(`unknown hash ${hashAlg}`)
  const trusted = keys.map(ed25519Key)
  if (!trusted.some((k) => k.equals(signer))) throw new Error("signed by a key that is not trusted")

  const signed = Buffer.concat([MAGIC, sshString(ns), sshString(reserved), sshString(hashAlg), sshString(createHash(hashAlg).update(message).digest())])
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: signer.toString("base64url") }, format: "jwk" })
  if (!verify(null, signed, key, raw)) throw new Error("the signature does not match")
}
