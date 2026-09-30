// =================================================================
// 加密系統 — 欄位級 AES-256-GCM (encryption.js)
//
// 格式：
//   v2（現行）：enc:v2:<kid>:<base64url(nonce 12B)>:<base64url(ciphertext‖tag 16B)>
//   v1（僅讀取相容）：enc:<iv hex 16B>:<tag hex>:<ct hex>（無 AAD）
//
// 行為：
//   - encrypt 失敗一律拋 EncryptionError（fail-closed，絕不回傳明文）
//   - decrypt 失敗（格式錯/金鑰錯/AAD 錯/被篡改）一律回傳 null，不產生佔位字串
//   - 金鑰輪替：當前金鑰 SANCTUARY_ENCRYPTION_KEY（kid 來自 SANCTUARY_ENCRYPTION_KEY_ID，預設 k1），
//     舊金鑰放 SANCTUARY_ENCRYPTION_KEYS_OLD（kid=64hex,kid=64hex）
// =================================================================

const crypto = require('crypto');

const KID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const NONCE_LEN = 12;
const TAG_LEN = 16;

class EncryptionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EncryptionError';
    }
}

function parseOldKeys(raw) {
    const map = {};
    if (!raw || !raw.trim()) return map;
    for (const item of raw.split(',')) {
        const s = item.trim();
        if (!s) continue;
        const i = s.indexOf('=');
        const kid = i > 0 ? s.slice(0, i).trim() : '';
        const key = i > 0 ? s.slice(i + 1).trim() : '';
        if (!KID_RE.test(kid) || !HEX64_RE.test(key)) {
            throw new Error('SANCTUARY_ENCRYPTION_KEYS_OLD 格式錯誤，應為 kid=64位十六進位制,kid=64位十六進位制');
        }
        map[kid] = key.toLowerCase();
    }
    return map;
}

function strictB64urlDecode(s) {
    if (typeof s !== 'string' || !B64URL_RE.test(s)) return null;
    const buf = Buffer.from(s, 'base64url');
    // 拒絕非標準（末位多餘 bit）編碼，避免同一密文有多種字串表示
    if (buf.toString('base64url') !== s) return null;
    return buf;
}

class SanctuaryEncryption {
    constructor() {
        // 從環境變數獲取加密金鑰
        this.encryptionKey = process.env.SANCTUARY_ENCRYPTION_KEY;
        this.algorithm = 'aes-256-gcm';

        if (!this.encryptionKey) {
            console.error('❌ 未找到SANCTUARY_ENCRYPTION_KEY環境變數！');
            throw new Error('加密金鑰未設定');
        }

        if (!HEX64_RE.test(this.encryptionKey)) {
            console.error('❌ 加密金鑰格式不正確，應為64個十六進位制字元');
            throw new Error('加密金鑰格式錯誤');
        }

        this.keyId = process.env.SANCTUARY_ENCRYPTION_KEY_ID || 'k1';
        if (!KID_RE.test(this.keyId)) {
            throw new Error('SANCTUARY_ENCRYPTION_KEY_ID 格式錯誤，應為 [A-Za-z0-9_-]{1,16}');
        }
        this.oldKeys = parseOldKeys(process.env.SANCTUARY_ENCRYPTION_KEYS_OLD);

        console.log(`🔐 加密系統初始化成功 (kid=${this.keyId}, 舊金鑰 ${Object.keys(this.oldKeys).length} 把)`);
    }

    _currentKey() {
        const key = Buffer.from(String(this.encryptionKey || ''), 'hex');
        if (key.length !== 32) throw new EncryptionError('加密金鑰無效');
        return key;
    }

    // 依 kid 取金鑰；未知 kid 回傳 null
    _keyForKid(kid) {
        if (kid === this.keyId) return this._currentKey();
        const hex = this.oldKeys && this.oldKeys[kid];
        return hex ? Buffer.from(hex, 'hex') : null;
    }

    // 加密文本。opts.aad：可選字串，解密時必須提供相同值
    // 加密失敗拋 EncryptionError（訊息不含明文）；非字串/空字串原樣回傳
    encrypt(text, opts = {}) {
        if (typeof text !== 'string' || text === '') return text;

        try {
            const key = this._currentKey();
            const nonce = crypto.randomBytes(NONCE_LEN);
            const cipher = crypto.createCipheriv(this.algorithm, key, nonce, { authTagLength: TAG_LEN });
            const aad = opts && opts.aad;
            if (aad != null && aad !== '') cipher.setAAD(Buffer.from(String(aad), 'utf8'));
            const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
            const tag = cipher.getAuthTag();
            return `enc:v2:${this.keyId}:${nonce.toString('base64url')}:${Buffer.concat([ct, tag]).toString('base64url')}`;
        } catch (error) {
            if (error instanceof EncryptionError) throw error;
            // 刻意不帶原始 error.message，避免任何可能的明文外洩
            throw new EncryptionError('加密失敗');
        }
    }

    _decryptV2(parts, aad) {
        const [, kid, nonceB64, dataB64] = parts;
        const key = this._keyForKid(kid);
        if (!key || key.length !== 32) return null;
        const nonce = strictB64urlDecode(nonceB64);
        const data = strictB64urlDecode(dataB64);
        if (!nonce || nonce.length !== NONCE_LEN || !data || data.length < TAG_LEN) return null;
        const ct = data.subarray(0, data.length - TAG_LEN);
        const tag = data.subarray(data.length - TAG_LEN);
        const decipher = crypto.createDecipheriv(this.algorithm, key, nonce, { authTagLength: TAG_LEN });
        decipher.setAuthTag(tag);
        if (aad != null && aad !== '') decipher.setAAD(Buffer.from(String(aad), 'utf8'));
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    }

    _decryptV1(parts) {
        const [ivHex, tagHex, ctHex] = parts;
        if (![ivHex, tagHex, ctHex].every(p => /^([0-9a-fA-F]{2})*$/.test(p))) return null;
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        if (iv.length !== 16 || tag.length !== TAG_LEN) return null;
        const candidates = [];
        try { candidates.push(this._currentKey()); } catch (_) { /* 無效當前金鑰，僅試舊金鑰 */ }
        for (const hex of Object.values(this.oldKeys || {})) candidates.push(Buffer.from(hex, 'hex'));
        for (const key of candidates) {
            try {
                const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
                decipher.setAuthTag(tag);
                return decipher.update(ctHex, 'hex', 'utf8') + decipher.final('utf8');
            } catch (_) { /* 換下一把 */ }
        }
        return null;
    }

    // 解密文本。失敗回傳 null（不再回傳佔位字串）。
    // opts.aad：v2 密文加密時若帶了 aad，解密必須相同；opts.silent 只靜默 log。
    // 未加密字串（無 enc: 字首）與非字串/空值原樣回傳。
    decrypt(encryptedText, opts = {}) {
        if (!encryptedText || typeof encryptedText !== 'string') {
            return encryptedText;
        }
        if (!encryptedText.startsWith('enc:')) {
            return encryptedText;
        }

        const o = opts || {};
        try {
            const parts = encryptedText.substring(4).split(':');
            let out = null;
            if (parts[0] === 'v2' && parts.length === 4) {
                out = this._decryptV2(parts, o.aad);
            } else if (parts.length === 3) {
                out = this._decryptV1(parts);
            }
            if (out === null && !o.silent) console.warn('解密失敗（格式錯誤、金鑰/AAD 不符或資料被篡改）');
            return out;
        } catch (_) {
            if (!o.silent) console.warn('解密失敗（格式錯誤、金鑰/AAD 不符或資料被篡改）');
            return null;
        }
    }

    // 僅供顯示：解密失敗時回傳 fallback（絕不可把結果寫回 DB）
    decryptForDisplay(encryptedText, fallback = '（無法解密）', opts = {}) {
        const out = this.decrypt(encryptedText, opts);
        return out === null ? fallback : out;
    }

    // 金鑰輪替：用（舊）金鑰解開，再以當前金鑰 + v2 重新加密。
    // aad 同時用於 v2 來源的解密與新密文的加密（v1 來源沒有 aad）。
    // 空值/非字串原樣回傳；明文（無 enc: 字首）會直接以 v2 加密；無法解密則拋 EncryptionError。
    rotate(ciphertext, opts = {}) {
        if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
        const plain = this.decrypt(ciphertext, { aad: opts && opts.aad, silent: true });
        if (plain === null) throw new EncryptionError('無法解密，不能輪替');
        return this.encrypt(plain, { aad: opts && opts.aad });
    }

    // 檢查文本是否已加密（一律回傳 boolean）
    isEncrypted(text) {
        return typeof text === 'string' && text.startsWith('enc:');
    }
}

// 建立全域性加密例項
const encryption = new SanctuaryEncryption();

// 匯出供index.js使用
module.exports = {
    encryption,
    EncryptionError
};
