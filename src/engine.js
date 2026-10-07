// ================= 資料層：Proxy 引擎（與 TUI/HTTP 展示層解耦） =================
// 職責：
//   1. 多併發請求處理（每個請求一個獨立 Session）
//   2. API Key 池管理（GAS 輪換、熱/冷 Key、pacing）
//   3. 歷史紀錄寫入 SQLite
//   4. 以 EventEmitter 對外發事件，展示層（TUI / HTTP）訂閱即可
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const crypto = require('crypto');
const {
    GAS_URL, NVIDIA_BASE_URL,
    PACING_DELAY_SEC, IDLE_SKIP_SEC, BACKOFF_MINUTES,
} = require('./config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ProxyEngine extends EventEmitter {
    /**
     * @param {import('./db').HistoryDB} db
     */
    constructor(db) {
        super();
        this.db = db;

        // ---- Key 池（跨 session 共享，非同步安全） ----
        this.currentKey = null;
        this.totalKeys = 1;
        // 每把 Key 的狀態：{ warm: boolean, lastSuccess: number }
        this.keyStats = new Map();
        this._keyFetching = null; // GAS 取 Key 的 in-flight Promise（防止併發重複抓取）

        // ---- 活躍 sessions：sessionId -> session ----
        this.sessions = new Map();
    }

    // ---------- 事件輔助 ----------
    log(msg)  { this.emit('log', msg); }
    error(msg){ this.emit('errorLog', msg); }

    _updateSession(session, patch) {
        Object.assign(session, patch);
        this.emit('session', session);
    }

    _removeSession(session) {
        this.sessions.delete(session.id);
        this.emit('sessionEnd', session);
    }

    // ---------- 快取 ----------
    // 正規化路徑：客戶端帶不帶 /v1 前綴都支援，內部統一成不帶前綴
    // 例如 /v1/chat/completions 與 /chat/completions 視為同一支 API
    static normalizeUrl(url) {
        return String(url).replace(/^\/v1(?=\/|$)/, '') || '/';
    }

    // ---------- Key 管理 ----------
    _keyTail(key) { return key ? key.slice(-4) : '????'; }

    _keyState(key) {
        if (!this.keyStats.has(key)) {
            this.keyStats.set(key, { warm: false, lastSuccess: 0 });
        }
        return this.keyStats.get(key);
    }

    async fetchKeyFromGAS() {
        // 併發下多個 session 同時發現需要換 Key 時，共用同一個抓取 Promise
        if (this._keyFetching) return this._keyFetching;

        this._keyFetching = (async () => {
            try {
                this.emit('gasState', true);
                // GAS 有機率故障（回 HTML 錯誤頁等），重試最多 5 次
                const delays = [0, 2000, 5000, 10000, 15000];
                let lastErr = null;
                for (let attempt = 0; attempt < delays.length; attempt++) {
                    if (delays[attempt] > 0) {
                        this.log(`[Proxy] 🫧 GAS 抓取失敗，${delays[attempt] / 1000}s 後重試 (第 ${attempt}/${delays.length - 1})...`);
                        await sleep(delays[attempt]);
                    }
                    let rawText = '';
                    try {
                        this.log('[Proxy] 正在向 GAS 獲取最久未使用的 Key...');
                        const res = await fetch(GAS_URL);
                        rawText = await res.text();
                        const data = JSON.parse(rawText);
                        if (data.error) throw new Error(data.error);
                        this.currentKey = data.key;
                        this.totalKeys = data.total || 1;
                        this.log(`[Proxy] 成功切換 API Key (結尾: ...${this._keyTail(this.currentKey)})${attempt > 0 ? `（重試 ${attempt} 次後成功）` : ''}`);
                        lastErr = null;
                        break;
                    } catch (e) {
                        lastErr = `回傳內容: ${rawText ? rawText.substring(0, 100) : '(無法取得回應)'} | 錯誤: ${e.message}`;
                    }
                }
                if (lastErr) {
                    this.error(`[Proxy] ❌ 從 GAS 獲取 Key 失敗（已重試 ${delays.length - 1} 次）: ${lastErr}`);
                }
            } catch (err) {
                this.error(`[Proxy] ❌ 從 GAS 獲取 Key 失敗: ${err.message}`);
            } finally {
                this.emit('gasState', false);
                this._keyFetching = null;
            }
        })();
        return this._keyFetching;
    }

    // 計算 pacing（使用「該 Key」的狀態，而非全域）
    _computePacing(key) {
        const now = Date.now();
        const st = this._keyState(key);
        const elapsed = st.lastSuccess > 0 ? now - st.lastSuccess : Infinity;

        let waitMs = 0;
        let modeTag = '[cold-key]';
        if (st.warm) {
            if (elapsed >= IDLE_SKIP_SEC * 1000) {
                modeTag = '[idle-direct]';
            } else {
                waitMs = Math.max(0, PACING_DELAY_SEC * 1000 - elapsed);
                const waitSec = (waitMs / 1000).toFixed(1);
                modeTag = waitMs > 0 ? `[warm-key wait ${waitSec}s]` : '[interval-ok]';
            }
        }
        return { waitMs, modeTag };
    }

    // ---------- 主請求處理（Express middleware）----------
    handle = async (req, res) => {
        const url = ProxyEngine.normalizeUrl(req.originalUrl);
        const session = {
            id: crypto.randomBytes(4).toString('hex'),
            method: req.method,
            url,
            state: 'waiting',          // waiting | generating | backoff | cached
            keyTail: this._keyTail(this.currentKey),
            attempt: 1,
            totalKeys: this.totalKeys,
            modeTag: '',
            backoffRound: 0,
            backoffEnd: 0,
            startTime: Date.now(),
            firstByteTime: null,
            ttft: 0,
            clientAborted: false,
        };
        this.sessions.set(session.id, session);

        const dbId = this.db.startRecord({
            sessionId: session.id,
            startedAt: session.startTime,
            method: req.method,
            url,
            keyTail: session.keyTail,
        });

        let finalized = false;
        const finalize = (result) => {
            if (finalized) return;
            finalized = true;
            const now = Date.now();
            this.db.finishRecord(dbId, {
                endedAt: now,
                status: result.status ?? null,
                ttftMs: session.ttft ? session.ttft * 1000 : null,
                genMs: session.firstByteTime ? now - session.firstByteTime : null,
                keyTail: session.keyTail,
                attempts: session.attempt,
                backoffRounds: session.backoffRound,
                error: result.error ?? null,
                cached: 0,
            });
            this._removeSession(session);
        };

        // 客戶端中止：記錄下來，但「不」中斷上游請求，繼續跑完以留存結果
        res.on('close', () => {
            if (!res.writableEnded && !session.clientAborted) {
                session.clientAborted = true;
                this.log(`[Proxy] ⚠ [${session.id}] 客戶端已中止連線，但會繼續跑完上游請求以留存結果。`);
                this._updateSession(session, {});
            }
        });

        // ===== 1. CF 524 規避：等待上游期間主動 keep-alive =====
        // Cloudflare 在 100s 內沒收到回應就會切線。在等待上游（可能 4 分鐘+）時：
        //   - stream 請求：先回 200 + SSE headers，每 25s 寫一個 SSE comment
        //   - 非 stream：退而求其次先送出 headers
        // 代價：若上游最終失敗，HTTP status 會是已送出的 200（錯誤本體仍照樣轉發）。
        const wantStream = (() => {
            try { return JSON.parse((req.body || Buffer.alloc(0)).toString()).stream === true; }
            catch { return false; }
        })();
        let keepAliveInterval = null;
        const keepAliveTimer = setTimeout(() => {
            if (session.clientAborted || res.headersSent || res.writableEnded) return;
            if (wantStream) {
                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    'connection': 'keep-alive',
                });
                res.write(': keep-alive\n\n');
                keepAliveInterval = setInterval(() => {
                    if (!res.writableEnded && !res.destroyed) {
                        try { res.write(': keep-alive\n\n'); } catch { /* ignore */ }
                    }
                }, 25000);
            } else {
                res.writeHead(200, { 'content-type': 'application/json' });
            }
            this.log(`[Proxy] 🫧 [${session.id}] 上游等待超過 45s，已先送出 headers/keep-alive 以避免 CF 524。`);
        }, 45000);
        const stopKeepAlive = () => {
            clearTimeout(keepAliveTimer);
            if (keepAliveInterval) clearInterval(keepAliveInterval);
        };
        res.on('close', stopKeepAlive);

        // ===== 2. 快取 miss → 打 NVIDIA =====
        if (!this.currentKey) await this.fetchKeyFromGAS();
        session.keyTail = this._keyTail(this.currentKey);
        this._updateSession(session, {});

        // 將本次請求統計（供成功時 log）
        const reportDone = (status) => {
            const now = Date.now();
            if (status === 200 && session.startTime) {
                const ttft = session.ttft || ((session.firstByteTime ?? now) - session.startTime) / 1000;
                const gen = session.firstByteTime ? (now - session.firstByteTime) / 1000 : 0;
                this.log(`[Proxy] ✨ [${session.id}] TTFT: ${ttft.toFixed(2)}s | 生成耗時: ${gen.toFixed(2)}s`);
            }
        };

        try {
            await this._runWithRetry(req, res, session, finalize, reportDone);
        } catch (error) {
            const detail = error.cause ? (error.cause.code || error.cause.message || error.cause) : '無詳細原因';
            this.error(`[Proxy 本地/網路例外] ❌ [${session.id}] 錯誤: ${error.message} (原因: ${detail})`);
            if (!res.writableEnded && !res.destroyed && !res.headersSent) {
                res.status(500).json({ error: 'Proxy 內部錯誤', message: error.message });
            } else if (!res.writableEnded && !res.destroyed) {
                res.end(JSON.stringify({ error: 'Proxy 內部錯誤', message: error.message }));
            }
            finalize({ status: 500, error: error.message });
        }
    };

    async _runWithRetry(req, res, session, finalize, reportDone) {
        const roundDelays = [0, ...BACKOFF_MINUTES.map(m => m * 60 * 1000)];
        let lastFailed = null; // { status, headers: [[k,v]...], body: Buffer }

        // 成功回應轉發給客戶端（若還活著），同時收集完整 body 以存入快取
        const deliverAndStore = async (status, pairedHeaders, bodyStream) => {
            const outHeaders = pairedHeaders.filter(([k]) => k.toLowerCase() !== 'content-encoding');

            // keep-alive 可能已搶先送出 headers，此後不可再改 status/headers
            if (!session.clientAborted && !res.headersSent) {
                res.status(status);
                for (const [k, v] of outHeaders) res.setHeader(k, v);
            }

            const chunks = [];
            if (bodyStream) {
                const nodeStream = Readable.fromWeb(bodyStream);

                nodeStream.once('data', () => {
                    const now = Date.now();
                    this._updateSession(session, {
                        state: 'generating',
                        firstByteTime: now,
                        ttft: (now - session.startTime) / 1000,
                    });
                });

                nodeStream.on('data', (chunk) => {
                    chunks.push(chunk);
                    const chunkStr = chunk.toString();
                    if (chunkStr.includes('"error"') ||
                        chunkStr.includes('Internal server error') ||
                        chunkStr.includes('Internal Server Error')) {
                        this.error(`\n[NVIDIA 串流內錯誤] ⚠ [${session.id}] 回傳內容包含錯誤:\n${chunkStr.trim()}\n`);
                    }
                });

                const done = new Promise((resolve, reject) => {
                    nodeStream.on('end', resolve);
                    nodeStream.on('error', reject);
                });

                // 客戶端還活著才轉發（中止也繼續把串流讀完）
                // 手動 write、不自動 end：空回應時保留連線讓上層透明重試
                if (!session.clientAborted) {
                    nodeStream.on('data', (chunk) => {
                        if (!res.writableEnded && !res.destroyed) res.write(chunk);
                    });
                } else {
                    nodeStream.resume();
                }

                await done;
            }

            const body = Buffer.concat(chunks);

            // 上游 200 但 body 空（瞬時過載被斷）：客戶端連線還在 → 回傳 null 讓上層直接重試
            if (status === 200 && body.length === 0 && !session.clientAborted && !res.writableEnded && !res.destroyed) {
                return null;
            }

            reportDone(status);

            if (!session.clientAborted && !res.writableEnded && !res.destroyed) {
                res.end();
            }
            return status;
        };

        for (let round = 0; round < roundDelays.length; round++) {
            const delayMs = roundDelays[round];
            session.backoffRound = round;

            if (delayMs > 0) {
                const waitMin = BACKOFF_MINUTES[round - 1];
                this.log(`[Proxy] ⏳ [${session.id}] 全部 Key 皆遇到 429。進入第 ${round} 次退避等待 (${waitMin} 分鐘)${session.clientAborted ? '（客戶端已中止，仍繼續留存結果）' : ''}...`);
                this._updateSession(session, { state: 'backoff', backoffEnd: Date.now() + delayMs });
                await sleep(delayMs);
                this.log(`[Proxy] ⏰ [${session.id}] 等待 ${waitMin} 分鐘結束，重新輪詢所有 Key...`);
            }

            const triedKeys = new Set();

            while (triedKeys.size < this.totalKeys) {
                const key = this.currentKey;
                const targetUrl = `${NVIDIA_BASE_URL}${session.url}`;

                const headers = { ...req.headers };
                delete headers.host;
                delete headers.connection;
                delete headers['content-length'];
                delete headers['transfer-encoding'];
                headers.authorization = `Bearer ${key}`;

                const fetchOptions = {
                    method: req.method,
                    headers,
                    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
                };

                // Pacing
                const { waitMs, modeTag } = this._computePacing(key);
                this._updateSession(session, {
                    state: 'waiting',
                    keyTail: this._keyTail(key),
                    attempt: triedKeys.size + 1,
                    totalKeys: this.totalKeys,
                    modeTag,
                });

                if (waitMs > 0) await sleep(waitMs);

                let response;
                let exhaustRound = false;
                for (;;) {
                    try {
                        response = await fetch(targetUrl, fetchOptions);
                    } catch (error) {
                        const detail = error.cause ? (error.cause.code || error.cause.message || error.cause) : '無詳細原因';
                        throw new Error(`fetch 失敗: ${error.message} (原因: ${detail})`, { cause: error });
                    }

                    // 401/429/404 → 換 Key（401 通常是 GAS 故障給了壞 key，或 key 失效）
                    if (response.status === 401 || response.status === 429 || response.status === 404) {
                        const st = this._keyState(key);
                        st.warm = false;
                        st.lastSuccess = 0;
                        triedKeys.add(key);
                        const reqId = response.headers.get('nvcf-reqid') || '無';
                        this.log(`[Proxy] ⚠ [${session.id}] 遇到 ${response.status} (reqid: ${reqId})。本輪已嘗試: ${triedKeys.size}/${this.totalKeys}`);

                        // 收集失敗回應（覆蓋掉上一把 Key 的）
                        const failBody = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
                        lastFailed = {
                            status: response.status,
                            headers: [...response.headers.entries()],
                            body: failBody,
                        };

                        if (triedKeys.size < this.totalKeys) {
                            this.log(`[Proxy] 🔄 [${session.id}] 正在向 GAS 申請換下一把 Key 重試...`);
                            await this.fetchKeyFromGAS();
                            break; // 跳出重試迴圈，外層 while 用新 key
                        }
                        exhaustRound = true;
                        break;
                    }

                    // 其他錯誤狀態
                    if (response.status !== 200) {
                        const reqId = response.headers.get('nvcf-reqid') || '無';
                        const nvStatus = response.headers.get('nvcf-status') || '無';
                        let errorBodyText = '';
                        try { errorBodyText = await response.clone().text(); } catch (_) {}
                        this.error(`\n[NVIDIA 伺服器錯誤] ⚠ [${session.id}] HTTP ${response.status} (${req.method} ${targetUrl})`);
                        this.error(`  ├─ NVIDIA Request ID: ${reqId}`);
                        this.error(`  ├─ NVIDIA 狀態: ${nvStatus}`);
                        this.error(`  └─ NVIDIA 回傳 Body: ${errorBodyText || '(空回應)'}\n`);
                    }

                    // 200：把這把 Key 標記為熱
                    if (response.status === 200) {
                        const st = this._keyState(key);
                        st.warm = true;
                        st.lastSuccess = Date.now();
                    }

                    // 轉發 + 收集；回傳 null = 上游 200 空回應 → 同一把 Key 直接重試（無限次）
                    const status = await deliverAndStore(
                        response.status,
                        [...response.headers.entries()],
                        response.body,
                    );
                    if (status === null) {
                        this.log(`[Proxy] 🫧 [${session.id}] 上游 200 空回應（瞬時過載），同一把 Key 直接重試。`);
                        continue;
                    }
                    finalize({ status, error: session.clientAborted ? 'client aborted (result saved)' : null });
                    return;
                }
                if (exhaustRound) break;
            }
        }

        // 所有退避輪次耗盡
        this.log(`[Proxy] ❌ [${session.id}] 經過所有退避等待輪次，全部 Key 依然無效。`);
        if (lastFailed && !session.clientAborted && !res.headersSent) {
            res.status(lastFailed.status);
            for (const [k, v] of lastFailed.headers) {
                if (k.toLowerCase() !== 'content-encoding') res.setHeader(k, v);
            }
            res.end(lastFailed.body);
            finalize({ status: lastFailed.status, error: 'all keys exhausted' });
        } else if (lastFailed && !session.clientAborted) {
            // headers 已搶先送出（keep-alive），只能把錯誤本體當成功回應尾巴補上
            res.end(lastFailed.body);
            finalize({ status: lastFailed.status, error: 'all keys exhausted (early-headers sent)' });
        } else if (!lastFailed && !session.clientAborted && !res.headersSent) {
            res.status(429).json({ error: 'All keys exhausted after full backoff cycle.' });
            finalize({ status: 429, error: 'all keys exhausted' });
        } else if (!lastFailed && !session.clientAborted) {
            res.end(JSON.stringify({ error: 'All keys exhausted after full backoff cycle.' }));
            finalize({ status: 429, error: 'all keys exhausted (early-headers sent)' });
        } else {
            finalize({ status: lastFailed?.status ?? 429, error: 'all keys exhausted (client aborted)' });
        }
    }
}

module.exports = { ProxyEngine };
