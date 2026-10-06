// ================= 展示層：TUI 多連線儀表板（blessed 版） =================
// 風格向 opencode 看齊：面板化區塊 + 彩色狀態 chip + 分段 status bar。
// 訂閱 ProxyEngine 事件；未來 HTTP 前端可直接訂閱同樣的 engine 事件。
const blessed = require('blessed');

const C = {
    panelS: '#1d3e48',   // Sessions 島底（深青，白字對比足夠）
    panelL: '#3f3f3f',   // Logs 島底（灰，整塊含內文）
    titleS: '#2e5f6e',   // Sessions 島標題列（同家族稍亮，與內文相連）
    titleL: '#545454',   // Logs 島標題列（同家族稍亮，與內文相連）
    chipLog:'#9aa7b4',   // log 時間戳 chip 底（亮一點，黑字對比足夠）
    // 注意：避免純灰（#808080 等），會被終端機映射到 8 色盤的亮黑 → 橘色
    dim:    '#8b9bb4',
    accent: '#5fd7ff',   // cyan
    ok:     '#5fd75f',   // green
    warn:   '#ffd75f',   // yellow
    err:    '#ff5f5f',   // red
    violet: '#af87ff',
    // status bar：同一色系（slate 藍灰）由深到淺
    barBg:  '#24283b',
    chipA:  '#3b4261',
    chipB:  '#414868',
    chipC:  '#565f89',
};

const SESSION_PANEL_H = 9; // sessions 面板固定高度（含邊框）

class TUI {
    /**
     * @param {import('./engine').ProxyEngine} engine
     * @param {import('./db').HistoryDB} db
     */
    constructor(engine, db, { refreshMs = 100, port = '' } = {}) {
        this.port = port;
        this.engine = engine;
        this.db = db;
        this.dotIndex = 0;
        this.gasActive = false;
        this.runStats = { completed: 0, totalTTFT: 0, totalGen: 0, rateLimited: 0 };

        // ---------- 畫面結構 ----------
        this.screen = blessed.screen({
            smartCSR: true,
            fullUnicode: true,
            title: 'Nvidia NIM Proxy',
        });

        // 頂部標題列
        this.header = blessed.box({
            top: 0, left: 0, width: '100%', height: 1,
            tags: true,
            style: { fg: 'white' },
        });

        // Sessions 島：頂上與 header 空一列；標題列 + 內文同家族色底，左右各留 1 格縫隙
        this.sessionTitle = blessed.box({
            top: 2, left: 1, right: 1, height: 1,
            tags: true,
            style: { bg: C.titleS, fg: '#e8f4f8' },
        });

        this.sessionBox = blessed.box({
            top: 3, left: 1, right: 1, height: SESSION_PANEL_H,
            tags: true,
            style: { bg: C.panelS },
        });

        // Logs 島：與 Sessions 島之間空一列；底下與 status bar 也空一列
        this.logTitle = blessed.box({
            top: 4 + SESSION_PANEL_H, left: 1, right: 1, height: 1,
            tags: true,
            style: { bg: C.titleL, fg: '#e8e8e8' },
        });

        this.logBox = blessed.log({
            top: 5 + SESSION_PANEL_H, left: 1, right: 1,
            height: `100%-${5 + SESSION_PANEL_H + 2}`,
            scrollable: true, alwaysScroll: true,
            scrollbar: { ch: '█', style: { fg: C.dim, bg: 'default', track: { bg: 'default' } } },
            keys: true, vi: true, mouse: true,
            tags: true,
            style: { bg: C.panelL },
        });

        // 底部 status bar（分段彩色）
        this.statusBar = blessed.box({
            bottom: 0, left: 0, width: '100%', height: 1,
            tags: true,
        });

        // TTFT 折線圖覆蓋層（按 c 切換，置中顯示）
        this.chartVisible = false;
        this.chartBox = blessed.box({
            top: 'center', left: 'center',
            width: '70%', height: 14,
            tags: true,
            hidden: true,
            style: { bg: '#1c2333', fg: '#e0e0e0' },
        });

        this.screen.append(this.header);
        this.screen.append(this.sessionTitle);
        this.screen.append(this.sessionBox);
        this.screen.append(this.logTitle);
        this.screen.append(this.logBox);
        this.screen.append(this.statusBar);
        this.screen.append(this.chartBox);

        this.screen.key(['C-c', 'q'], () => {
            if (this.chartVisible) { this.chartVisible = false; this.chartBox.hide(); this.screen.render(); return; }
            this._exit();
        });
        this.screen.key(['c'], () => {
            this.chartVisible = !this.chartVisible;
            if (this.chartVisible) this.chartBox.show(); else this.chartBox.hide();
            this.render();
        });
        this.screen.key(['escape'], () => {
            if (this.chartVisible) { this.chartVisible = false; this.chartBox.hide(); this.screen.render(); }
        });

        // ---------- 事件訂閱 ----------
        engine.on('session', () => this.render());
        engine.on('sessionEnd', (s) => {
            if (s.ttft) {
                this.runStats.completed++;
                this.runStats.totalTTFT += s.ttft;
                if (s.firstByteTime) this.runStats.totalGen += (Date.now() - s.firstByteTime) / 1000;
            }
            this.render();
        });
        engine.on('gasState', (active) => { this.gasActive = active; this.render(); });
        engine.on('log', (msg) => this.log(msg));
        engine.on('errorLog', (msg) => this.error(msg));

        this.timer = setInterval(() => {
            this.dotIndex++;
            this.render();
        }, refreshMs);
        this.timer.unref?.();

        this.screen.on('resize', () => {
            this.screen.alloc();
            this.render();
        });
    }

    // ---------- 日誌（時間戳灰底 pill + 左留白，省略 [Proxy] 前綴） ----------
    _stamp() {
        const t = new Date().toTimeString().slice(0, 8);
        return `{black-fg}{${C.chipLog}-bg} ${t} {/${C.chipLog}-bg}{/black-fg}`;
    }
    _clean(msg) {
        return String(msg).replace(/^\[Proxy\]\s*/, '');
    }
    log(msg)   { this.logBox.log(`${this._stamp()} ${this._clean(msg)}`); this.screen.render(); }
    error(msg) { this.logBox.log(`${this._stamp()} {${C.err}-fg}${this._clean(msg)}{/${C.err}-fg}`); this.screen.render(); }

    // ---------- Session 行 ----------
    _chip(text, color) { return `{${color}-fg}${text}{/${color}-fg}`; }

    _sessionLine(s) {
        const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][this.dotIndex % 10];
        const now = Date.now();
        const aborted = s.clientAborted ? ` ${this._chip('✕ aborted', C.err)}` : '';
        const meta = `{${C.dim}-fg}${s.id} · key …${s.keyTail}{/${C.dim}-fg}`;

        switch (s.state) {
            case 'waiting': {
                const elapsed = ((now - s.startTime) / 1000).toFixed(1);
                return `${this._chip(spinner, C.warn)} ${this._chip('waiting', C.warn)}  ${meta}  ${elapsed}s · ${s.modeTag || ''} · try ${s.attempt}/${s.totalKeys}${aborted}`;
            }
            case 'generating': {
                const elapsed = ((now - (s.firstByteTime ?? now)) / 1000).toFixed(1);
                const ttft = s.ttft ? s.ttft.toFixed(2) : '0.00';
                return `${this._chip(spinner, C.ok)} ${this._chip('generating', C.ok)}  ${meta}  ${elapsed}s · TTFT ${ttft}s${aborted}`;
            }
            case 'backoff': {
                const remaining = Math.max(0, Math.ceil((s.backoffEnd - now) / 1000));
                return `${this._chip(spinner, C.err)} ${this._chip('backoff 429', C.err)}  ${meta}  retry in ${remaining}s · round ${s.backoffRound}${aborted}`;
            }
            default:
                return `${this._chip('•', C.dim)} ${s.state}  ${meta}${aborted}`;
        }
    }

    // ---------- 渲染 ----------
    render() {
        const width = Math.max(30, this.screen.width - 2);

        // header
        const port = this.port;
        const keyTail = this.engine.currentKey ? this.engine.currentKey.slice(-4) : '----';
        this.header.setContent(
            ` {bold}{${C.accent}-fg}Nvidia NIM Proxy{/${C.accent}-fg}{/bold}` +
            `  {${C.dim}-fg}· port ${port} · key …${keyTail}{/${C.dim}-fg}` +
            (this.gasActive ? `  ${this._chip('⟳ fetching key…', C.warn)}` : '')
        );

        // 島標題列（淺色字在色底上，確保可讀）
        this.sessionTitle.setContent(' {bold}▣ Sessions{/bold}');
        this.logTitle.setContent(` {bold}▣ Logs{/bold}`);

        // sessions panel
        const sessions = [...this.engine.sessions.values()];
        const innerH = SESSION_PANEL_H;
        if (sessions.length === 0) {
            this.sessionBox.setContent(`{${C.dim}-fg}  no active connections{/${C.dim}-fg}`);
        } else {
            const lines = sessions.slice(0, innerH).map(s => ' ' + this._fitTags(this._sessionLine(s), width));
            if (sessions.length > innerH) {
                lines[innerH - 1] = ` {${C.dim}-fg}… ${sessions.length - innerH + 1} more{/${C.dim}-fg}`;
            }
            this.sessionBox.setContent(lines.join('\n'));
        }

        // status bar：分段彩色 chip
        let stats;
        try { stats = this.db.stats(); } catch { stats = null; }
        const count = stats?.count ?? 0;
        const avgTTFT = count > 0 && stats.avg_ttft != null ? (stats.avg_ttft / 1000).toFixed(2) : '-';
        const avgGen = count > 0 && stats.avg_gen != null ? (stats.avg_gen / 1000).toFixed(2) : '-';
        const runAvg = this.runStats.completed > 0 ? (this.runStats.totalTTFT / this.runStats.completed).toFixed(2) : '-';

        // status bar：左組=本次執行（now），右組=歷史累計（all），quit 獨立在組外
        this.statusBar.style.bg = C.barBg;
        const chip = (text, bg) => `{white-fg}{${bg}-bg} ${text} {/${bg}-bg}{/white-fg}`;
        const label = (text) => `{${C.dim}-fg}{${C.barBg}-bg}${text}{/${C.barBg}-bg}{/${C.dim}-fg}`;
        const sp = (n = 1) => `{${C.barBg}-bg}${' '.repeat(n)}{/${C.barBg}-bg}`;

        const left =
            sp(1) + label('now') + sp(1) +
            chip(`● active ${sessions.length}`, sessions.length > 0 ? '#3d5a45' : C.chipA) + sp(1) +
            chip(`run ${this.runStats.completed} ok`, C.chipB) + sp(1) +
            chip(`TTFT ${runAvg}s`, C.chipA) + sp(2);

        const right =
            label('all') + sp(1) +
            chip(`history ${count}`, C.chipB) + sp(1) +
            chip(`TTFT ${avgTTFT}s`, C.chipA) + sp(1) +
            chip(`gen ${avgGen}s`, C.chipB) + sp(1) +
            chip(`429 ${stats?.rate_limited ?? 0}`, (stats?.rate_limited ?? 0) > 0 ? '#6e3b3b' : C.chipA);

        const quit = chip('q quit', C.violet) + sp(1);

        // 中間留白撐開：quit 與右組之間至少 2 格空隙
        const used = this._visWidth(left) + this._visWidth(right) + this._visWidth(quit);
        const gapN = Math.max(2, this.screen.width - used - 2);
        this.statusBar.setContent(this._fitTags(left + sp(gapN) + right + sp(2) + quit, this.screen.width));

        // TTFT 折線圖覆蓋層
        if (this.chartVisible) {
            this.chartBox.setContent(this._buildChart());
        }

        this.screen.render();
    }

    // ---------- TTFT 折線圖（ASCII） ----------
    _buildChart() {
        const w = Math.max(20, Math.floor(this.screen.width * 0.7) - 8);
        const h = 8;
        let series = [];
        try { series = this.db.ttftSeries(w); } catch { /* ignore */ }

        const title = ` {bold}{${C.accent}-fg}TTFT 折線圖{/bold}{/${C.accent}-fg} {${C.dim}-fg}(最近 ${series.length} 筆 · 按 c/Esc 關閉){/${C.dim}-fg}`;
        if (series.length < 2) return `${title}\n\n  資料不足`;

        const vals = series.map(p => p.ttft);
        const min = Math.min(...vals), max = Math.max(...vals);
        const span = max - min || 1;

        // 畫布：grid[y][x]，y=0 是頂部（大值）
        const grid = Array.from({ length: h }, () => new Array(w).fill(' '));
        for (let x = 0; x < w; x++) {
            const i = Math.min(series.length - 1, Math.floor(x * series.length / w));
            const v = series[i].ttft;
            const y = Math.round((1 - (v - min) / span) * (h - 1));
            grid[y][x] = '●';
            // 垂直連線到上一個點
            if (x > 0) {
                const pi = Math.max(0, Math.floor((x - 1) * series.length / w));
                const pv = series[pi].ttft;
                const py = Math.round((1 - (pv - min) / span) * (h - 1));
                for (let yy = Math.min(y, py) + 1; yy < Math.max(y, py); yy++) {
                    if (grid[yy][x] === ' ') grid[yy][x] = '│';
                }
            }
        }

        const lines = grid.map((row, y) => {
            // 左軸標示：頂部 max、底部 min
            let axis = '     ';
            if (y === 0) axis = `${max.toFixed(1).padStart(4)}s`;
            if (y === h - 1) axis = `${min.toFixed(1).padStart(4)}s`;
            return ` {${C.dim}-fg}${axis}│{/${C.dim}-fg}` +
                `{${C.accent}-fg}${row.join('')}{/${C.accent}-fg}`;
        });
        lines.push(`       {${C.dim}-fg}${'└' + '─'.repeat(w)}{/${C.dim}-fg}`);
        lines.push(`       {${C.dim}-fg}max ${max.toFixed(2)}s · min ${min.toFixed(2)}s{/${C.dim}-fg}`);
        return [title, '', ...lines].join('\n');
    }

    // 計算 tag 字串的可見寬度
    _visWidth(s) {
        const plain = String(s).replace(/\{[^}]*\}/g, '');
        let w = 0;
        for (const ch of plain) w += /[^\x00-\xff]/.test(ch) ? 2 : 1;
        return w;
    }

    // 保留 tag、依可見寬度截斷
    _fitTags(s, width) {
        let w = 0, i = 0, out = '';
        const str = String(s);
        while (i < str.length && w < width) {
            if (str[i] === '{') {
                const end = str.indexOf('}', i);
                if (end === -1) break;
                out += str.slice(i, end + 1);
                i = end + 1;
                continue;
            }
            const ch = str[i];
            const cw = /[^\x00-\xff]/.test(ch) ? 2 : 1;
            if (w + cw > width) break;
            w += cw;
            out += ch;
            i++;
        }
        return out + '{/}';
    }

    _exit() {
        this.destroy();
        process.exit(0);
    }

    destroy() {
        clearInterval(this.timer);
        this.screen.destroy();
    }
}

module.exports = { TUI };
