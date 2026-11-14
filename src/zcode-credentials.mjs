// ZCode デスクトップアプリ（/Applications/ZCode.app）が保存している認証情報を読む。
//
// 使用量リセット権（coding-plan の 5時間枠 / 週枠のリセット）は、Z.AI の
// coding-plan API（https://zcode.z.ai/api/v1/coding-plan/reset/*）が要求する
//   Authorization: Bearer <zcodejwttoken>
//   X-Bigmodel-Authorization: <oauth:zai:access_token>
// の2つを必要とする。どちらも ZCode の credentials.json に
//   enc:v1:<iv>.<tag>.<ciphertext>   (base64url, AES-256-GCM)
// で暗号化されて保存されている。
//
// 復号鍵は ZCode CLI（zcode.cjs）と同じ規則:
//   secret = env ZCODE_CREDENTIAL_SECRET
//          ?? `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
//   key    = sha256(secret)
// この鍵は同じユーザーのローカルプロセスから再現できる（macOS Keychain は使わない）。
//
// 取得したトークンはこのモジュールの返り値としてホスト側プロセス内だけで扱い、
// クライアント（ブラウザ）には一切渡さない。

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

const ENC_PREFIX = "enc:v1:";
const SECRET_ENV = "ZCODE_CREDENTIAL_SECRET";

function credentialSecret(env = process.env) {
  const explicit = env[SECRET_ENV]?.trim();
  if (explicit) return explicit;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* userInfo() が失敗する環境では unknown のまま（ZCode CLI と同じ挙動） */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function cipherKey(env = process.env) {
  return createHash("sha256").update(credentialSecret(env)).digest();
}

function gcmDecrypt(ivB64, tagB64, dataB64, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/** enc:v1（ZCode 旧フォールバック鍵）を復号する。 */
function decryptV1(value, key) {
  const [iv, tag, data] = value.slice(ENC_PREFIX.length).split(".");
  if (!iv || !tag || !data) throw new Error("ZCode 認証情報の形式が不正です");
  return gcmDecrypt(iv, tag, data, key);
}

const V2_PREFIX = "enc:v2:";
// ZCode 本体（app.asar）と同じ: サービス名固定、アカウント = sha256(credentials.json の絶対パス) の hex。
const V2_KEYCHAIN_SERVICE = "ZCode Credential Encryption";
let keychainKeyCache = null;

/**
 * macOS Keychain に保存された enc:v2 用 32 バイト鍵を取得する。
 * ZCode 本体は @napi-rs/keyring（macOS では Keychain）に保存しているため、
 * security コマンドで同じエントリを読む。値はプロセス内だけで使い捨て。
 */
async function loadKeychainKey(credentialsPath) {
  if (keychainKeyCache) return keychainKeyCache;
  const account = createHash("sha256").update(credentialsPath).digest("hex");
  const stdout = await new Promise((resolve, reject) => {
    execFile("security", ["find-generic-password", "-s", V2_KEYCHAIN_SERVICE, "-a", account, "-w"], { timeout: 15_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) reject(err);
      else resolve(String(out));
    });
  });
  const key = Buffer.from(stdout.trim(), "base64url");
  if (key.length !== 32) throw new Error("Keychain の鍵の長さが不正です");
  keychainKeyCache = key;
  return key;
}

/**
 * enc:v2 を復号する。source が "os" なら Keychain の鍵、"env" なら
 * 従来の ZCODE_CREDENTIAL_SECRET 由来の鍵（鍵fingerprintは sha256(key) 先頭12バイト）。
 */
async function decryptV2(value, credentialsPath, env = process.env) {
  const rest = value.slice(V2_PREFIX.length);
  const [source, fp, payload] = rest.split(":");
  if (source !== "os" && source !== "env") throw new Error(`ZCode 認証情報の enc:v2 ソースが不明です: ${source}`);
  const [iv, tag, data] = (payload ?? "").split(".");
  if (!iv || !tag || !data) throw new Error("ZCode 認証情報の形式が不正です");
  let key;
  if (source === "os") {
    key = await loadKeychainKey(credentialsPath);
  } else {
    const secret = env[SECRET_ENV]?.trim();
    if (!secret) throw new Error("enc:v2:env の鍵候補（ZCODE_CREDENTIAL_SECRET）がありません");
    key = createHash("sha256").update(secret).digest();
  }
  // 鍵が正しいか fingerprint（sha256(key) 先頭12バイト hex）で確認
  const fpExpect = createHash("sha256").update(key).digest().subarray(0, 12).toString("hex");
  if (fp !== fpExpect) throw new Error("enc:v2 の鍵fingerprintが一致しません");
  return gcmDecrypt(iv, tag, data, key);
}

async function decryptValue(value, key, credentialsPath, env) {
  if (typeof value !== "string") return value;
  if (value.startsWith(V2_PREFIX)) return decryptV2(value, credentialsPath, env);
  if (!value.startsWith(ENC_PREFIX)) return value;
  return decryptV1(value, key);
}

/** credentials.json の置き場所。ZCODE_HOME を尊重する（ZCode CLI と同じ）。 */
export function zcodeCredentialsPath(env = process.env) {
  const base = env.ZCODE_HOME?.trim() || homedir();
  return join(base, ".zcode", "v2", "credentials.json");
}

/**
 * ZCode の coding-plan リセットに必要なトークンを返す。
 * 認証情報が無い / 復号できない場合は null（呼び出し側はリセット機能を出さない）。
 *
 * @returns {Promise<{ zcodeJwt: string, zaiAccessToken: string } | null>}
 */
export async function loadZcodeResetCredentials(env = process.env) {
  let raw;
  try {
    raw = JSON.parse(await readFile(zcodeCredentialsPath(env), "utf8"));
  } catch {
    return null;
  }
  const key = cipherKey(env);
  const credPath = zcodeCredentialsPath(env);
  let zcodeJwt;
  let zaiAccessToken;
  try {
    zcodeJwt = (await decryptValue(raw["zcodejwttoken"], key, credPath, env))?.trim();
    zaiAccessToken = (await decryptValue(raw["oauth:zai:access_token"], key, credPath, env))?.trim();
  } catch {
    return null; // 鍵が違う / Keychain が許可されていない / 壊れている
  }
  if (!zcodeJwt || !zaiAccessToken) return null;
  return { zcodeJwt, zaiAccessToken };
}
