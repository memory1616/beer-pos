const { generateKeyPairSync, createHash, randomBytes } = require('crypto');
const fs = require('fs');

// Generate Ed25519 key pair in DER format
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { format: 'der', type: 'spki' },
  privateKeyEncoding: { format: 'der', type: 'pkcs8' }
});

// Build OpenSSH public key: ssh-ed25519 <base64(type + blob)>
function sshString(str) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(str.length);
  return Buffer.concat([len, Buffer.from(str)]);
}
function sshBlob(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshBlob(publicKey)]);
const pubKeyB64 = pubBlob.toString('base64');
const comment = 'cursor-agent@beer-pos';
const sshPubKeyFormatted = `ssh-ed25519 ${pubKeyB64} ${comment}`;

// Build OpenSSH private key format (v1)
// For ed25519: private_key_blob = 32-byte scalar + 32-byte public key
const ed25519PrivBlob = Buffer.concat([privateKey.slice(-32), publicKey]);

const check1 = Buffer.alloc(4); check1.writeUInt32BE(0x12345678);
const check2 = Buffer.alloc(4); check2.writeUInt32BE(0x12345678);

const privBlock = Buffer.concat([
  check1,
  sshString(comment),
  pubBlob,                        // public key blob
  sshBlob(ed25519PrivBlob),       // private key blob (scalar + A)
  sshString(comment),              // comment
  check2
]);

// OpenSSH format: auth_magic + rest (all base64'd together)
const authMagic = Buffer.from('openssh-key-v1\x00');
const rest = Buffer.concat([
  sshString('none'),               // cipher
  sshString('none'),               // kdf
  sshBlob(Buffer.alloc(0)),       // kdf options (empty)
  sshString(pubBlob),              // public key blob
  sshString(privBlock)             // private block
]);

const b64 = Buffer.concat([authMagic, rest]).toString('base64');
const opensshPrivate = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  ...b64.match(/.{1,70}/g),
  '-----END OPENSSH PRIVATE KEY-----'
].join('\n');

fs.writeFileSync('D:/Beer/cursor_deploy_key', opensshPrivate, { mode: 0o600 });
fs.writeFileSync('D:/Beer/cursor_deploy_key.pub', sshPubKeyFormatted, { mode: 0o644 });

console.log('=== PUBLIC KEY (add vao server: ~/.ssh/authorized_keys) ===');
console.log(sshPubKeyFormatted);
console.log('');
console.log('Done! Files:');
console.log('  Private: D:/Beer/cursor_deploy_key');
console.log('  Public:  D:/Beer/cursor_deploy_key.pub');
