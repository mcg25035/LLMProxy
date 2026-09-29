// ================= 資料層：SQLite 歷史紀錄 =================
// 使用 Node.js 內建 node:sqlite（零外部依賴）
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('./config');

class HistoryDB {
    constructor(dbPath = DB_PATH) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS requests (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id   TEXT    NOT NULL,
                started_at   INTEGER NOT NULL,   -- ms epoch
                ended_at     INTEGER,            -- ms epoch
                method       TEXT,
                url          TEXT,
                status       INTEGER,
                ttft_ms      REAL,
                gen_ms       REAL,
                key_tail     TEXT,
                attempts     INTEGER DEFAULT 1,
                backoff_rounds INTEGER DEFAULT 0,
                error        TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_requests_started ON requests(started_at);
            CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status);
            CREATE TABLE IF NOT EXISTS cache (
                hash        TEXT PRIMARY KEY,    -- sha256(method + url + body)
                method      TEXT,
                url         TEXT,
                status      INTEGER,
                headers     TEXT,                -- JSON
                body        BLOB,
                created_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);
        `);
        // requests 表補上 cached 欄位（舊 DB 自動升級）
        try {
            this.db.exec(`ALTER TABLE requests ADD COLUMN cached INTEGER DEFAULT 0`);
        } catch (_) { /* 欄位已存在 */ }
        this._insert = this.db.prepare(`
            INSERT INTO requests (session_id, started_at, method, url, key_tail)
            VALUES (?, ?, ?, ?, ?)
        `);
        this._finalize = this.db.prepare(`
            UPDATE requests
            SET ended_at = ?, status = ?, ttft_ms = ?, gen_ms = ?,
                key_tail = ?, attempts = ?, backoff_rounds = ?, error = ?, cached = ?
            WHERE id = ?
        `);
    }

    // ===== 24 小時請求快取 =====
    getCache(hash, maxAgeMs) {
        const row = this.db.prepare(
            `SELECT status, headers, body, created_at FROM cache WHERE hash = ?`
        ).get(hash);
        if (!row) return null;
        if (Date.now() - row.created_at > maxAgeMs) return null; // 過期視為 miss
        return {
            status: row.status,
            headers: JSON.parse(row.headers),
            body: row.body ? Buffer.from(row.body) : Buffer.alloc(0),
        };
    }

    setCache(hash, { method, url, status, headers, body }) {
        this.db.prepare(`
            INSERT OR REPLACE INTO cache (hash, method, url, status, headers, body, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(hash, method, url, status, JSON.stringify(headers), body, Date.now());
    }

    purgeExpiredCache(maxAgeMs) {
        const info = this.db.prepare(`DELETE FROM cache WHERE created_at < ?`)
            .run(Date.now() - maxAgeMs);
        return Number(info.changes);
    }

    // 請求開始：回傳 row id
    startRecord({ sessionId, startedAt, method, url, keyTail }) {
        const info = this._insert.run(sessionId, startedAt, method, url, keyTail);
        return Number(info.lastInsertRowid);
    }

    // 請求結束
    finishRecord(id, { endedAt, status, ttftMs, genMs, keyTail, attempts, backoffRounds, error, cached = 0 }) {
        this._finalize.run(endedAt, status, ttftMs, genMs, keyTail, attempts, backoffRounds, error, cached, id);
    }

    // ===== 事後分析查詢 =====
    stats(sinceMs = 0) {
        return this.db.prepare(`
            SELECT COUNT(*) AS count,
                   AVG(ttft_ms) AS avg_ttft,
                   AVG(gen_ms)  AS avg_gen,
                   SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) AS ok,
                   SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS rate_limited
            FROM requests WHERE started_at >= ?
        `).get(sinceMs);
    }

    // TTFT 折線圖資料：由舊到新（秒）
    ttftSeries(limit = 48) {
        const rows = this.db.prepare(`
            SELECT started_at AS ts, ttft_ms FROM requests
            WHERE ttft_ms IS NOT NULL
            ORDER BY id DESC LIMIT ?
        `).all(limit);
        return rows.reverse().map(r => ({ ts: r.ts, ttft: r.ttft_ms / 1000 }));
    }

    recent(limit = 50) {
        return this.db.prepare(`
            SELECT * FROM requests ORDER BY id DESC LIMIT ?
        `).all(limit);
    }

    close() {
        this.db.close();
    }
}

module.exports = { HistoryDB };
