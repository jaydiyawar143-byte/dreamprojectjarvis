// ---------------------------------------------------------------------------
// Phase 19.2 — throwaway mutual-TLS material for the browser-service tests.
//
// The service accepts only mutual TLS, so its tests need a CA, a server
// certificate and a client certificate. Node can make keys and sign bytes but
// has no API that writes an X.509 certificate, and an `openssl` binary is not
// on every developer's PATH. This builds the few DER structures a certificate
// needs, signs them with node:crypto, and writes the PEM files to a fresh
// temporary directory.
//
// Test material only: P-256 keys generated per run, valid for one day, never
// written inside the repository and never used by anything but these tests.
// ---------------------------------------------------------------------------

import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const octets = (content: Buffer) => tlv(0x04, content);
const bits = (content: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);

function integer(value: Buffer): Buffer {
  const body = value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out: number[] = [a! * 40 + b!];
  for (const value of rest) {
    const chunk: number[] = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const name = (commonName: string) => seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function extension(id: string, value: Buffer, critical = false): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

interface Subject {
  commonName: string;
  kind: "ca" | "server" | "client";
}

function certificate(subject: Subject, publicKey: KeyObject, issuer: { commonName: string; key: KeyObject }): string {
  const now = Date.now();
  const extensions =
    subject.kind === "ca"
      ? [
          extension("2.5.29.19", seq(bool(true)), true),
          extension("2.5.29.15", bits(Buffer.from([0x06]), 1), true),
        ]
      : [
          extension("2.5.29.19", seq(), true),
          extension("2.5.29.15", bits(Buffer.from([0x80]), 7), true),
          extension(
            "2.5.29.37",
            seq(oid(subject.kind === "server" ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2"))
          ),
          ...(subject.kind === "server"
            ? [extension("2.5.29.17", seq(tlv(0x87, Buffer.from([127, 0, 0, 1])), tlv(0x82, Buffer.from("localhost"))))]
            : []),
        ];

  const serial = randomBytes(8);
  serial[0] = serial[0]! & 0x7f;
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(issuer.commonName),
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    name(subject.commonName),
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(...extensions))
  );
  const signature = sign("sha256", tbs, issuer.key);
  const der = seq(tbs, ECDSA_SHA256, bits(signature));
  const body = der.toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`;
}

const pemKey = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();

export interface TestTlsMaterial {
  dir: string;
  caPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  clientCertPath: string;
  clientKeyPath: string;
  /** A client certificate for another identity, signed by the same CA. */
  otherClientCertPath: string;
  otherClientKeyPath: string;
  /** A client certificate signed by a CA the service does not trust. */
  strangerCertPath: string;
  strangerKeyPath: string;
}

/** One CA, a server certificate for 127.0.0.1, and client certificates. */
export function createTestTls(clientIdentity: string): TestTlsMaterial {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-browser-tls-"));
  const write = (file: string, text: string) => {
    const path = join(dir, file);
    writeFileSync(path, text);
    return path;
  };
  const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  const ca = pair();
  const caName = "jarvis-test-ca";
  const caCert = certificate({ commonName: caName, kind: "ca" }, ca.publicKey, { commonName: caName, key: ca.privateKey });

  const server = pair();
  const client = pair();
  const other = pair();
  const strangerCa = pair();
  const stranger = pair();

  return {
    dir,
    caPath: write("ca.crt", caCert),
    serverCertPath: write(
      "server.crt",
      certificate({ commonName: "browser-service", kind: "server" }, server.publicKey, { commonName: caName, key: ca.privateKey })
    ),
    serverKeyPath: write("server.key", pemKey(server.privateKey)),
    clientCertPath: write(
      "client.crt",
      certificate({ commonName: clientIdentity, kind: "client" }, client.publicKey, { commonName: caName, key: ca.privateKey })
    ),
    clientKeyPath: write("client.key", pemKey(client.privateKey)),
    otherClientCertPath: write(
      "other.crt",
      certificate({ commonName: "someone-else", kind: "client" }, other.publicKey, { commonName: caName, key: ca.privateKey })
    ),
    otherClientKeyPath: write("other.key", pemKey(other.privateKey)),
    strangerCertPath: write(
      "stranger.crt",
      certificate({ commonName: clientIdentity, kind: "client" }, stranger.publicKey, {
        commonName: "a-ca-nobody-trusts",
        key: strangerCa.privateKey,
      })
    ),
    strangerKeyPath: write("stranger.key", pemKey(stranger.privateKey)),
  };
}
