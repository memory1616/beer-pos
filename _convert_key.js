const fs = require('fs');
const crypto = require('crypto');

// Read the PEM public key
const pem = fs.readFileSync('D:/Beer/_k_1782360718674.pem', 'utf8');

// Parse the PEM to get the raw bytes
const lines = pem.split('\n');
const base64 = lines.filter(l => !l.startsWith('-----')).join('');
const der = Buffer.from(base64, 'base64');

// Build OpenSSH format: "ssh-rsa" + MPInt + MPInt
// The DER structure is SubjectPublicKeyInfo: AlgorithmIdentifier + BIT STRING
// We need to extract the RSA modulus and exponent from inside

// Parse the DER manually
let offset = 0;
function readTag(data, pos) {
  const tag = data[pos];
  const len = data[pos + 1];
  const start = pos + 2 + (len > 127 ? (len & 0x7f) : 0);
  const valueStart = pos + 2 + (len > 127 ? (len & 0x7f) : 0);
  const actualLen = len > 127 ? (data[pos + 2] << 24 | data[pos + 3] << 16 | data[pos + 4] << 8 | data[pos + 5]) & 0x0fffffff : len;
  return { tag, len, valueStart, actualLen, end: valueStart + actualLen };
}

// Skip SEQUENCE (the BIT STRING wrapper)
// SEQUENCE { SEQUENCE { OID rsaEncryption NULL } BIT STRING { SEQUENCE { INTEGER n INTEGER e } } }
let pos = 0;
// outer SEQUENCE
let s1 = readTag(der, pos);
pos = s1.valueStart;
// SEQUENCE (AlgorithmIdentifier)
let s2 = readTag(der, pos);
pos = s2.end;
// BIT STRING
let bs = readTag(der, pos);
pos = bs.valueStart;
// skip the unused bits byte
pos++;
// SEQUENCE (RSAPublicKey)
let s3 = readTag(der, pos);
pos = s3.valueStart;
// INTEGER (n)
let nTag = readTag(der, pos);
let n = der.slice(nTag.valueStart, nTag.end);
pos = nTag.end;
// INTEGER (e)
let eTag = readTag(der, pos);
let e = der.slice(eTag.valueStart, eTag.end);
pos = eTag.end;

// SSH format: string "ssh-rsa" + mpint e + mpint n
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function toMPInt(buf) {
  // Add leading zero if high bit is set (for positive numbers)
  let b = buf;
  if (buf[0] & 0x80) {
    b = Buffer.concat([Buffer.from([0]), buf]);
  }
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

const sshKey = Buffer.concat([Buffer.from('ssh-rsa'), toMPInt(e), toMPInt(n)]);
const sshKeyB64 = sshKey.toString('base64');

console.log('ssh-rsa', sshKeyB64, 'cursor-deploy-server');
