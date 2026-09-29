// ================= 入口：組裝資料層與展示層 =================
// 分層架構：
//   - src/db.js     資料層：SQLite 歷史紀錄
//   - src/engine.js 資料層：Proxy 引擎（多併發 session、Key 管理、EventEmitter）
//   - src/tui.js    展示層：終端機多連線儀表板
//   - public/       展示層：React Web 儀表板（GET /）
// HTTP API（供前端）：GET /_api/stats /_api/ttft /_api/sessions
const path = require('path');
const express = require('express');
const { Agent, setGlobalDispatcher } = require('undici');
const { PORT, PROXY_API_KEY } = require('./src/config');
const { HistoryDB } = require('./src/db');
const { ProxyEngine } = require('./src/engine');
const { TUI } = require('./src/tui');

// 🎯 將等待標頭與 Body 的超時設為 0（永久等待）
setGlobalDispatcher(new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 60000,
}));

const db = new HistoryDB();
const engine = new ProxyEngine(db);
const tui = new TUI(engine, db, { port: PORT });

const app = express();

// ---- 前端儀表板（React，靜態檔案）與 JSON API：不需 API Key ----
app.use(express.static(path.join(__dirname, 'public')));

const bootTime = Date.now();

app.get('/_api/stats', (_req, res) => {
    let all = null, now = null;
    try { all = db.stats(); now = db.stats(bootTime); } catch { /* ignore */ }
    const map = (s) => s ? {
        count: s.count,
        ok: s.ok,
        avgTTFT: s.avg_ttft != null ? s.avg_ttft / 1000 : null,
        avgGen: s.avg_gen != null ? s.avg_gen / 1000 : null,
        rateLimited: s.rate_limited,
    } : null;
    res.json({
        now: { ...map(now), active: engine.sessions.size },
        all: map(all),
    });
});

app.get('/_api/ttft', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 48));
    try { res.json(db.ttftSeries(limit)); }
    catch { res.json([]); }
});

app.get('/_api/sessions', (_req, res) => {
    const now = Date.now();
    res.json([...engine.sessions.values()].map(s => ({
        id: s.id, method: s.method, url: s.url, state: s.state,
        keyTail: s.keyTail, attempt: s.attempt, totalKeys: s.totalKeys,
        modeTag: s.modeTag, backoffRound: s.backoffRound,
        elapsed: (now - s.startTime) / 1000,
        ttft: s.ttft || null,
        clientAborted: s.clientAborted,
        fromCache: s.fromCache,
    })));
});

// ---- OpenAI 相容 Proxy：捕捉原始 body 原封不動轉發 ----
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// 只代理 OpenAI 相容的 API 路徑；瀏覽器的雜項請求（favicon、devtools 探測等）
// 一律 404，絕不送去上游 LLM。
app.use((req, res, next) => {
    const url = ProxyEngine.normalizeUrl(req.originalUrl || req.url || '');
    if (/^\/(chat\/completions|completions|embeddings|responses|models)(\/|$)/.test(url)) return next();
    res.status(404).json({ error: { message: `unsupported path: ${url}`, type: 'invalid_request_error' } });
});

// 🔐 Bearer 驗證：PROXY_API_KEY 留空 = 接受任意請求
app.use((req, res, next) => {
    if (!PROXY_API_KEY) return next();
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m && m[1] === PROXY_API_KEY) return next();
    res.status(401).json({ error: { message: 'invalid api key', type: 'authentication_error' } });
});

app.use(engine.handle);

app.use((_req, res) => {
    res.status(404).json({ error: { message: 'not found', type: 'invalid_request_error' } });
});

app.listen(PORT, () => {
    tui.log(`[Proxy] API Key Aggregator 已啟動，請將 opencode base URL 設為 http://localhost:${PORT}`);
    tui.log(`[Proxy] Web 儀表板：http://localhost:${PORT}/`);
    tui.log(PROXY_API_KEY ? '[Proxy] 已啟用 API Key 驗證' : '[Proxy] 未設定 PROXY_API_KEY，接受任意請求');
    tui.render();
});

process.on('SIGINT', () => {
    tui.destroy();
    db.close();
    process.exit(0);
});
