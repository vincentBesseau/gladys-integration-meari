// -----------------------------------------------------------------------------
// Crypto helpers of the Meari cloud protocol (ieGeek Cam, CloudEdge...).
//
// Ported from the MIT-licensed Home Assistant integration
// https://github.com/Uxzylon/Ha-CloudPlus-Meari (api.py, coordinator/motion.py).
// Only node:crypto is used: no native or third-party dependency.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

// Fixed key material used by every Meari app to "encrypt" the password.
// The key is 24 bytes made of the same 8 bytes three times: 3DES-EDE with
// K1 = K2 = K3 is exactly single DES, which OpenSSL 3 no longer ships by
// default (legacy provider). Using des-ede3-cbc keeps Node happy.
const DES_KEY = Buffer.from('123456781234567812345678', 'utf8');
const DES_IV = Buffer.from('01234567', 'utf8');

export function hmacSha1Base64(message, key) {
  return crypto.createHmac('sha1', key).update(message, 'utf8').digest('base64');
}

export function md5Hex(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/** DES-CBC + PKCS7, base64: the password format of /meari/app/login. */
export function desEncrypt(plaintext) {
  const cipher = crypto.createCipheriv('des-ede3-cbc', DES_KEY, DES_IV);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

/** AES-128-CBC with IV = key (Meari convention), PKCS7, base64. */
export function aesEncrypt(plaintext, keyStr) {
  const key = Buffer.from(keyStr, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

export function aesDecrypt(ciphertextB64, keyStr) {
  const key = Buffer.from(keyStr, 'utf8');
  const padded = ciphertextB64 + '='.repeat((4 - (ciphertextB64.length % 4)) % 4);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([decipher.update(Buffer.from(padded, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * The account e-mail is sent AES-encrypted with a key derived from the request
 * path, the partner id, the ttid and the timestamp.
 */
export function encodeUserAccount(email, apiPath, timestampMs, partnerId, ttid) {
  const raw = `${apiPath}${partnerId}${ttid}${timestampMs}`;
  const key16 = Buffer.from(raw, 'utf8').toString('base64').slice(0, 16);
  return aesEncrypt(email, key16);
}

/**
 * Decrypt the platform signature returned by /v2/app/config/pf/init into the
 * OpenAPI credentials { accessid, accesskey }.
 */
export function decryptPlatformSignature(signature, { userId, partnerId, ttid, expireTime }) {
  const keyTemp = `${userId}${partnerId}${ttid}${expireTime}`;
  const key16 = Buffer.from(keyTemp, 'utf8').toString('base64').replace(/=+$/, '').slice(0, 16);
  const decrypted = aesDecrypt(signature, key16);
  const infoB64 = decrypted.split('-')[0];
  const padded = infoB64 + '='.repeat((4 - (infoB64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

/**
 * Event snapshots of battery cameras are lightly obfuscated (".jpgx3"): the
 * first 1024 bytes are XORed with the ASCII MD5 hex digest of
 * `<serial>|<serial length>|meari.stream`. Returns null when the result is not
 * a JPEG (unknown format, wrong serial).
 */
export function decodeEventSnapshot(data, snNum) {
  if (!data || data.length === 0) {
    return null;
  }
  if (isJpeg(data)) {
    return data;
  }
  if (!snNum) {
    return null;
  }
  const key = Buffer.from(md5Hex(`${snNum}|${snNum.length}|meari.stream`), 'utf8');
  const out = Buffer.from(data);
  const size = Math.min(1024, out.length);
  for (let i = 0; i < size; i += 1) {
    out[i] ^= key[i % key.length];
  }
  return isJpeg(out) ? out : null;
}

export function isJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
