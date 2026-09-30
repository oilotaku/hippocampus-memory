// =================================================================
// 加密系统 — 字段级 AES-256-GCM (encryption.js)
//
// 格式：
//   v2（现行）：enc:v2:<kid>:<base64url(nonce 12B)>:<base64url(ciphertext‖tag 16B)>
//   v1（仅读取兼容）：enc:<iv hex 16B>:<tag hex>:<ct hex>（无 AAD）
//
// 行为：
//   - encrypt 失败一律抛 EncryptionError（fail-closed，绝不回传明文）
//   - decrypt 失败（格式错/金钥错/AAD 错/被篡改）一律回传 null，不产生占位字串
//   - 金钥轮替：当前金钥 SANCTUARY_ENCRYPTION_KEY（kid 来自 SANCTUARY_ENCRYPTION_KEY_ID，预设 k1），
//     旧金钥放 SANCTUARY_ENCRYPTION_KEYS_OLD（kid=64hex,kid=64hex）
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
            throw new Error('SANCTUARY_ENCRYPTION_KEYS_OLD 格式错误，应为 kid=64位十六进制,kid=64位十六进制');
        }
        map[kid] = key.toLowerCase();
    }
    return map;
}

function strictB64urlDecode(s) {
    if (typeof s !== 'string' || !B64URL_RE.test(s)) return null;
    const buf = Buffer.from(s, 'base64url');
    // 拒绝非标准（末位多余 bit）编码，避免同一密文有多种字串表示
    if (buf.toString('base64url') !== s) return null;
    return buf;
}

class SanctuaryEncryption {
    constructor() {
        // 从环境变量获取加密密钥
        this.encryptionKey = process.env.SANCTUARY_ENCRYPTION_KEY;
        this.algorithm = 'aes-256-gcm';

        if (!this.encryptionKey) {
            console.error('❌ 未找到SANCTUARY_ENCRYPTION_KEY环境变量！');
            throw new Error('加密密钥未设置');
        }

        if (!HEX64_RE.test(this.encryptionKey)) {
            console.error('❌ 加密密钥格式不正确，应为64个十六进制字符');
            throw new Error('加密密钥格式错误');
        }

        this.keyId = process.env.SANCTUARY_ENCRYPTION_KEY_ID || 'k1';
        if (!KID_RE.test(this.keyId)) {
            throw new Error('SANCTUARY_ENCRYPTION_KEY_ID 格式错误，应为 [A-Za-z0-9_-]{1,16}');
        }
        this.oldKeys = parseOldKeys(process.env.SANCTUARY_ENCRYPTION_KEYS_OLD);

        console.log(`🔐 加密系统初始化成功 (kid=${this.keyId}, 旧金钥 ${Object.keys(this.oldKeys).length} 把)`);
    }

    _currentKey() {
        const key = Buffer.from(String(this.encryptionKey || ''), 'hex');
        if (key.length !== 32) throw new EncryptionError('加密金钥无效');
        return key;
    }

    // 依 kid 取金钥；未知 kid 回传 null
    _keyForKid(kid) {
        if (kid === this.keyId) return this._currentKey();
        const hex = this.oldKeys && this.oldKeys[kid];
        return hex ? Buffer.from(hex, 'hex') : null;
    }

    // 加密文本。opts.aad：可选字串，解密时必须提供相同值
    // 加密失败抛 EncryptionError（訊息不含明文）；非字串/空字串原样回传
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
            // 刻意不带原始 error.message，避免任何可能的明文外泄
            throw new EncryptionError('加密失败');
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
        try { candidates.push(this._currentKey()); } catch (_) { /* 无效当前金钥，仅试旧金钥 */ }
        for (const hex of Object.values(this.oldKeys || {})) candidates.push(Buffer.from(hex, 'hex'));
        for (const key of candidates) {
            try {
                const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
                decipher.setAuthTag(tag);
                return decipher.update(ctHex, 'hex', 'utf8') + decipher.final('utf8');
            } catch (_) { /* 换下一把 */ }
        }
        return null;
    }

    // 解密文本。失败回传 null（不再回传占位字串）。
    // opts.aad：v2 密文加密时若带了 aad，解密必须相同；opts.silent 只静默 log。
    // 未加密字串（无 enc: 前缀）与非字串/空值原样回传。
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
            if (out === null && !o.silent) console.warn('解密失败（格式错误、金钥/AAD 不符或数据被篡改）');
            return out;
        } catch (_) {
            if (!o.silent) console.warn('解密失败（格式错误、金钥/AAD 不符或数据被篡改）');
            return null;
        }
    }

    // 仅供显示：解密失败时回传 fallback（绝不可把结果写回 DB）
    decryptForDisplay(encryptedText, fallback = '（无法解密）', opts = {}) {
        const out = this.decrypt(encryptedText, opts);
        return out === null ? fallback : out;
    }

    // 金钥轮替：用（旧）金钥解开，再以当前金钥 + v2 重新加密。
    // aad 同时用于 v2 来源的解密与新密文的加密（v1 来源没有 aad）。
    // 空值/非字串原样回传；明文（无 enc: 前缀）会直接以 v2 加密；无法解密则抛 EncryptionError。
    rotate(ciphertext, opts = {}) {
        if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
        const plain = this.decrypt(ciphertext, { aad: opts && opts.aad, silent: true });
        if (plain === null) throw new EncryptionError('无法解密，不能轮替');
        return this.encrypt(plain, { aad: opts && opts.aad });
    }

    // 检查文本是否已加密（一律回传 boolean）
    isEncrypted(text) {
        return typeof text === 'string' && text.startsWith('enc:');
    }
}

// 创建全局加密实例
const encryption = new SanctuaryEncryption();

// 导出供index.js使用
module.exports = {
    encryption,
    EncryptionError
};
