// ================= 設定區 =================
// 全部設定來自環境變數；專案根目錄的 .env（KEY=VALUE 每行一筆）也會被載入，
// 已存在的環境變數優先。參考 .env.example。
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
    try {
        const envPath = path.join(__dirname, '..', '.env');
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (!m) continue;
            const val = m[2].replace(/^["']|["']$/g, '');
            if (!(m[1] in process.env)) process.env[m[1]] = val;
        }
    } catch { /* .env 不存在就算了 */ }
})();

module.exports = {
    PORT: Number(process.env.PORT) || 8868,
    GAS_URL: process.env.GAS_URL || '',
    NVIDIA_BASE_URL: (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),

    // 🔐 Proxy 自身的 API Key（OpenAI 相容 Bearer 驗證）；留空 = 接受任意請求
    PROXY_API_KEY: process.env.PROXY_API_KEY || '',

    // 🎯 連續請求間的最小安全間隔（秒）
    PACING_DELAY_SEC: 0,

    // 🎯 閒置直發門檻（秒）：距離上次請求成功超過此時間，直接秒發不等待！
    IDLE_SKIP_SEC: 0,

    // 當全部 Key 都 429 時的退避等待時間（分鐘）
    BACKOFF_MINUTES: [1, 2, 3],

    // 成功結果快取保留時間（預設 24 小時）
    CACHE_TTL_MS: Number(process.env.CACHE_TTL_MS) || 24 * 60 * 60 * 1000,

    // SQLite 歷史紀錄資料庫路徑
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'history.db'),
};
