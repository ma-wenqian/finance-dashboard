/* 个人资金看板
 *
 * 同一份页面有两种运行方式：
 *   本地模式  —— 直接双击 index.html 打开，数据存浏览器 localStorage
 *   服务器模式 —— 由 server/server.js 提供，登录后数据存服务器，按用户隔离
 * 启动时探测 /api/me，通不过就退回本地模式，所以离线双击照样能用。
 */
(function () {
'use strict';

var KEY = 'pf-dashboard-v1';
var $ = function (s, r) { return (r || document).querySelector(s); };
var view = $('#view');

/* ---------------- 存储层 ---------------- */
var Store = {
  mode: 'local',   // 'local' | 'server'
  user: null,
  rev: 0,
  status: 'idle',  // idle | saving | saved | offline | conflict
  pending: null,
  timer: null,

  cacheKey: function () { return KEY + (this.mode === 'server' && this.user ? ':' + this.user.id : ''); },

  probe: function () {
    return fetch('api/me', { headers: { 'X-Requested-With': 'pf' }, credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) return r.json().then(function (j) { throw { unauth: true, loginUrl: j.loginUrl }; });
        if (!r.ok) throw new Error('api/me ' + r.status);
        return r.json();
      })
      .then(function (me) { Store.mode = 'server'; Store.user = me.user; Store.rev = me.rev || 0; return me; })
      .catch(function (e) {
        if (e && e.unauth) throw e;
        Store.mode = 'local';   // 本地文件打开、或没有后端，都走这条
        return null;
      });
  },

  fetchState: function () {
    if (this.mode !== 'server') return Promise.resolve(readCache(this.cacheKey()));
    return fetch('api/data', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 404) return null;               // 服务器上还没有数据
      if (!r.ok) throw new Error('api/data ' + r.status);
      return r.json().then(function (j) { Store.rev = j.rev; return j.data; });
    });
  },

  /* 本地立刻写缓存；服务器模式再防抖推一次，网断了也不丢当前会话的数据 */
  push: function (state) {
    try { localStorage.setItem(this.cacheKey(), JSON.stringify(state)); } catch (e) { /* 隐私模式等 */ }
    if (this.mode !== 'server') return;
    this.pending = state;
    setStatus('saving');
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { Store.flush(); }, 700);
  },

  flush: function () {
    if (this.mode !== 'server' || !this.pending) return Promise.resolve();
    var payload = { rev: this.rev, data: this.pending };
    this.pending = null;
    return fetch('api/data', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pf' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.status === 409) return r.json().then(function (j) { Store.rev = j.rev; setStatus('conflict'); });
      if (!r.ok) throw new Error('保存失败 ' + r.status);
      return r.json().then(function (j) { Store.rev = j.rev; setStatus('saved'); });
    }).catch(function (e) { console.warn(e); setStatus('offline'); });
  }
};

function readCache(key) {
  try {
    var raw = localStorage.getItem(key);
    if (raw) { var d = JSON.parse(raw); if (d && d.accounts && d.months) return d; }
  } catch (e) { console.warn('读取本地缓存失败', e); }
  return null;
}
function setStatus(s) { Store.status = s; renderStatus(); }
function renderStatus() {
  var el = $('#userBox'); if (!el) return;
  if (Store.mode !== 'server') { el.innerHTML = '<span class="ubox local" title="数据存在这台电脑的浏览器里">本地</span>'; return; }
  var txt = { idle: '', saving: '保存中…', saved: '已保存', offline: '离线·未同步', conflict: '别处已改动' }[Store.status] || '';
  var kls = Store.status === 'offline' || Store.status === 'conflict' ? 'warn' : '';
  el.innerHTML = '<span class="ubox ' + kls + '" title="' + esc(Store.user ? (Store.user.email || Store.user.id) : '') + '">' +
    esc(Store.user && Store.user.name ? Store.user.name : '已登录') + (txt ? ' · ' + txt : '') + '</span>' +
    '<button class="icon-btn" data-act="logout" title="退出登录">⏻</button>';
}

/* ---------------- 状态 ---------------- */
var S = null;
var ui = { tab: 'overview', monthId: null, ccy: 'CNY' };
function normalize(d) {
  d.version = 1;
  d.baseCcy = d.baseCcy || 'CNY';
  d.accounts = d.accounts.map(function (a) {
    return {
      id: a.id, name: a.name, region: a.region, kind: a.kind,
      ccy: a.ccy || (a.region === 'hk' ? 'BOTH' : 'CNY'),
      limit: (a.limit === 0 || a.limit) ? +a.limit : null,
      note: a.note || '', active: a.active !== false
    };
  });
  d.months.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  d.months.forEach(function (m) {
    m.values = m.values || {};
    m.carried = m.carried || [];
    d.accounts.forEach(function (a) {
      var v = m.values[a.id];
      if (!v) m.values[a.id] = { hkd: 0, cny: 0 };
      else m.values[a.id] = { hkd: +v.hkd || 0, cny: +v.cny || 0 };
    });
  });
  return d;
}
function save() {
  S.baseCcy = ui.ccy;
  Store.push(S);
}

/* ---------------- 工具 ---------------- */
function accounts(all) { return S.accounts.filter(function (a) { return all ? true : a.active; }); }
function month(id) { for (var i = 0; i < S.months.length; i++) if (S.months[i].id === id) return S.months[i]; return null; }
function curMonth() { return month(ui.monthId) || S.months[S.months.length - 1] || null; }
function prevMonth(id) {
  var i = S.months.findIndex(function (m) { return m.id === id; });
  return i > 0 ? S.months[i - 1] : null;
}
/* 折算成人民币 */
function rmb(v, rate) { if (!v) return 0; return (v.hkd || 0) * rate + (v.cny || 0); }
/* 按当前显示币种换算（内部一律以人民币计算） */
function disp(vRmb, rate) { return ui.ccy === 'HKD' ? (rate ? vRmb / rate : 0) : vRmb; }
function sym() { return ui.ccy === 'HKD' ? 'HK$' : '¥'; }

function fmt(n, dec) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  var d = dec === undefined ? (Math.abs(n) >= 1000 ? 0 : 2) : dec;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function money(n, dec) { if (n === null || n === undefined || isNaN(n)) return '—'; return (n < 0 ? '-' : '') + sym() + fmt(Math.abs(n), dec); }
function signed(n, dec) { if (n === null || n === undefined || isNaN(n)) return '—'; if (!n) return '持平'; return (n > 0 ? '+' : '-') + sym() + fmt(Math.abs(n), dec); }
function cls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'faint'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/* 支持直接输入算式，如 42162-80000 或 1370+786+700 */
function parseNum(str) {
  if (str === null || str === undefined) return 0;
  var s = String(str).trim().replace(/[,，\s]/g, '').replace(/^=/, '');
  if (!s) return 0;
  if (/^-?\d*\.?\d*$/.test(s)) return +s || 0;
  if (!/^[0-9+\-*/().]+$/.test(s)) return NaN;
  try { var r = Function('"use strict";return (' + s + ')')(); return typeof r === 'number' && isFinite(r) ? Math.round(r * 100) / 100 : NaN; }
  catch (e) { return NaN; }
}

/* ---------------- 指标 ---------------- */
function metrics(m) {
  if (!m) return null;
  var rate = m.rate || 0.89;
  function sum(region, kind) {
    return accounts().reduce(function (s, a) {
      return (a.region === region && a.kind === kind) ? s + rmb(m.values[a.id], rate) : s;
    }, 0);
  }
  function build(region) {
    var o = { cash: sum(region, 'savings'), debt: sum(region, 'credit'), recv: sum(region, 'receivable'), invest: sum(region, 'invest') };
    o.total = o.cash + o.debt + o.recv + o.invest;
    return o;
  }
  var cn = build('cn'), hk = build('hk');
  return {
    rate: rate, cn: cn, hk: hk,
    cash: cn.cash + hk.cash,
    debt: cn.debt + hk.debt,
    recv: cn.recv + hk.recv,
    invest: cn.invest + hk.invest,
    total: cn.total + hk.total
  };
}

/* ---------------- 图表 ---------------- */
/* 单条线的小图，自己一套 y 轴 —— 只标最高最低两个值，够看出形状就行 */
function miniChart(vals, labels, color) {
  var W = 400, H = 132, PL = 46, PR = 12, PT = 12, PB = 22;
  var real = vals.filter(function (v) { return v !== null && !isNaN(v); });
  if (!real.length) return '<div class="empty" style="padding:24px">暂无数据</div>';
  var mn = Math.min.apply(null, real), mx = Math.max.apply(null, real);
  if (mn === mx) { mn -= Math.abs(mn) * 0.1 || 1; mx += Math.abs(mx) * 0.1 || 1; }
  var pad = (mx - mn) * 0.18;
  mn -= pad; mx += pad;
  var tick = tickFmt(mx - mn, mn, mx);
  var n = labels.length;
  var X = function (i) { return PL + (n <= 1 ? (W - PL - PR) / 2 : i * (W - PL - PR) / (n - 1)); };
  var Y = function (v) { return PT + (mx - v) / (mx - mn) * (H - PT - PB); };

  var g = '', i;
  for (i = 0; i <= 2; i++) {
    var val = mn + (mx - mn) * i / 2, y = Y(val);
    g += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '" stroke="var(--line2)" stroke-width="1"/>' +
      '<text x="' + (PL - 7) + '" y="' + (y + 3.4).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--faint)">' + tick(val) + '</text>';
  }
  if (mn < 0 && mx > 0) g += '<line x1="' + PL + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(0).toFixed(1) + '" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3" opacity=".65"/>';

  var xl = '';
  labels.forEach(function (l, k) {
    if (n > 6 && k % 2 && k !== n - 1) return;
    xl += '<text x="' + X(k).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="var(--faint)">' + esc(l) + '</text>';
  });

  var d = '', pts = '';
  vals.forEach(function (v, k) {
    if (v === null || isNaN(v)) return;
    d += (d ? ' L' : 'M') + X(k).toFixed(1) + ' ' + Y(v).toFixed(1);
    pts += '<circle cx="' + X(k).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="2.8" fill="var(--panel)" stroke="' + color + '" stroke-width="1.8"/>';
  });
  /* 一律填到图底，不是填到 0：数值全为负时「填向 0」会把色块画到线的上方，
     看着像线在色块下沿。跨零的情况已经有那条虚线标出来了。 */
  var base = H - PB;
  var area = d + ' L' + X(n - 1).toFixed(1) + ' ' + base + ' L' + X(0).toFixed(1) + ' ' + base + ' Z';

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;height:auto">' + g + xl +
    '<path d="' + area + '" fill="' + color + '" opacity=".09"/>' +
    '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' + pts + '</svg>';
}
/* y 轴刻度：以 k（千）为单位。
   - 全都在一千以内就写普通数字，写成「0.5k」反而看不出差别；
   - 区间小的时候多给一位小数，否则三个刻度会显示成同一个数。
   判断用的是「离零最远的那个值」，不是最大值 —— 曲线整体为负时
   最大值可能只有几千，但最小值是 -33k，那时候还是该用 k。 */
function tickFmt(span, mn, mx) {
  if (Math.max(Math.abs(mn), Math.abs(mx)) < 1000) {
    return function (v) { return Math.round(v).toLocaleString('zh-CN'); };
  }
  var dec = span >= 10000 ? 0 : span >= 1000 ? 1 : 2;
  return function (v) {
    var t = (v / 1000).toFixed(dec);
    if (/^-0(\.0+)?$/.test(t)) t = t.slice(1);   // 别显示成「-0.0k」
    return t + 'k';
  };
}

/* ---------------- 概览 ---------------- */
function renderOverview() {
  var m = curMonth();
  if (!m) return '<div class="card empty">还没有任何月份数据。<br><br><button class="btn" data-act="newmonth">新建一个月份</button></div>';
  var M = metrics(m), pm = prevMonth(m.id), PM = pm ? metrics(pm) : null;
  var r = M.rate;
  var d = function (v) { return disp(v, r); };
  var delta = function (cur, prev) { return PM ? d(cur - prev) : null; };

  var dTotal = delta(M.total, PM && PM.total);
  var h = '';

  h += '<div class="card hero">';
  h += '<div class="hero-main">';
  h += '<div class="hero-lbl">总资产 · ' + esc(m.date) + '</div>';
  h += '<div class="hero-val ' + (M.total < 0 ? 'neg' : '') + '">' + money(d(M.total)) + '</div>';
  h += '<div class="hero-sub">';
  h += (ui.ccy === 'CNY' ? '≈ HK$' + fmt(M.total / r, 0) : '≈ ¥' + fmt(M.total, 0)) + ' · 汇率 1 HKD = ' + r + ' CNY';
  if (dTotal !== null) h += ' · 环比 <span class="' + cls(dTotal) + '">' + signed(dTotal, 0) + '</span>';
  h += '</div></div>';
  h += '<div class="hero-side">';
  h += miniStat('内地 · 现金流', d(M.cn.cash), delta(M.cn.cash, PM && PM.cn.cash), 'var(--cn)');
  h += miniStat('内地 · 总余额', d(M.cn.total), delta(M.cn.total, PM && PM.cn.total), 'var(--cn)');
  h += miniStat('香港 · 现金流', d(M.hk.cash), delta(M.hk.cash, PM && PM.hk.cash), 'var(--hk)', 'HK$' + fmt(M.hk.cash / r, 0));
  h += miniStat('香港 · 总余额', d(M.hk.total), delta(M.hk.total, PM && PM.hk.total), 'var(--hk)', 'HK$' + fmt(M.hk.total / r, 0));
  h += '</div></div>';

  h += '<div class="sec-title">关键指标</div><div class="grid4">';
  h += tile('现金流合计', d(M.cash), delta(M.cash, PM && PM.cash), '内地 + 香港的储蓄类账户');
  h += tile('港股账户', d(M.invest), delta(M.invest, PM && PM.invest), 'HK$' + fmt(M.invest / r, 0));
  h += tile('信用卡欠款', d(-M.debt), PM ? d(-(M.debt - PM.debt)) : null, '负债总额（正数表示欠款）', true);
  h += tile('待入账 / 报销', d(M.recv), delta(M.recv, PM && PM.recv), '尚未到账、但已计入总资产');
  h += '</div>';

  if (window.SEED && window.SEED.demo) {
    h += '<div class="notice">这是<b>演示数据，全是编的</b>。随便改 —— 改动只存进你自己浏览器的 localStorage，' +
      '不会影响别人，也不会上传到任何地方。想复位就点右上角 <b>⋯ → ' + esc(resetLabel()) + '</b>。</div>';
  }
  if (m.carried && m.carried.length) {
    var names = m.carried.map(function (id) { var a = S.accounts.find(function (x) { return x.id === id; }); return a ? a.name : id; });
    h += '<div class="notice"><b>本月有 ' + m.carried.length + ' 个账户沿用了上月数值</b>（Excel 里当月未填写）：' + esc(names.join('、')) + '。到「录入」页改一下即可，改过的会自动去掉标记。</div>';
  }

  /* 趋势 */
  var ms = S.months, labels = ms.map(function (x) { return x.id.replace('20', '').replace('-', '/'); });
  var mets = ms.map(metrics);
  /* 四条线分开画：它们量级差太远（港股 3 万、香港 5 万、内地 -3 万），
     共用一个 y 轴的话各自的起伏全被压平。每张图自己缩放。 */
  var panels = [
    { name: '总资产', color: 'var(--accent)', get: function (x) { return x.total; } },
    { name: '内地总余额', color: 'var(--cn)', get: function (x) { return x.cn.total; } },
    { name: '香港总余额', color: 'var(--hk)', get: function (x) { return x.hk.total; } },
    { name: '港股', color: 'var(--stock)', get: function (x) { return x.invest; } }
  ];
  h += '<div class="sec-title">资产趋势</div><div class="chartgrid">';
  panels.forEach(function (p) {
    var vals = mets.map(function (x, i) { return disp(p.get(x), ms[i].rate); });
    var last = vals[vals.length - 1], prev = vals.length > 1 ? vals[vals.length - 2] : null;
    var dl = prev === null ? null : last - prev;
    h += '<div class="card panel">' +
      '<div class="panel-hd"><div><span class="dot" style="background:' + p.color + '"></span>' + p.name + '</div>' +
      '<div class="panel-val ' + (last < 0 ? 'neg' : '') + '">' + money(last, 0) +
      (dl === null ? '' : ' <span class="panel-dl ' + cls(dl) + '">' + signed(dl, 0) + '</span>') + '</div></div>' +
      miniChart(vals, labels, p.color) + '</div>';
  });
  h += '</div>';

  /* 月度汇总表 */
  h += '<div class="sec-title">月度汇总</div><div class="card tblwrap"><table><thead><tr>' +
    '<th>月份</th><th>汇率</th><th>内地现金流</th><th>内地总余额</th><th>香港现金流</th><th>香港总余额</th><th>港股</th><th>总资产</th><th>环比</th>' +
    '</tr></thead><tbody>';
  for (var i = ms.length - 1; i >= 0; i--) {
    var x = mets[i], mm = ms[i], pv = i > 0 ? mets[i - 1] : null;
    var dd = pv ? disp(x.total - pv.total, mm.rate) : null;
    h += '<tr' + (mm.id === m.id ? ' style="background:var(--accent-soft)"' : '') + '>' +
      '<td>' + esc(mm.date) + '</td><td class="faint">' + mm.rate + '</td>' +
      '<td>' + money(disp(x.cn.cash, mm.rate), 0) + '</td>' +
      '<td class="' + cls(x.cn.total) + '">' + money(disp(x.cn.total, mm.rate), 0) + '</td>' +
      '<td>' + money(disp(x.hk.cash, mm.rate), 0) + '</td>' +
      '<td class="' + cls(x.hk.total) + '">' + money(disp(x.hk.total, mm.rate), 0) + '</td>' +
      '<td>' + money(disp(x.invest, mm.rate), 0) + '</td>' +
      '<td style="font-weight:650" class="' + cls(x.total) + '">' + money(disp(x.total, mm.rate), 0) + '</td>' +
      '<td class="' + (dd === null ? 'faint' : cls(dd)) + '">' + (dd === null ? '—' : signed(dd, 0)) + '</td></tr>';
  }
  h += '</tbody></table></div>';

  /* 账户明细 */
  h += '<div class="sec-title">账户明细 · ' + esc(m.date) + '</div><div class="card tblwrap"><table><thead><tr>' +
    '<th>账户</th><th>港币 HKD</th><th>人民币 CNY</th><th>折合 ' + (ui.ccy === 'HKD' ? 'HKD' : 'CNY') + '</th><th>环比</th></tr></thead><tbody>';
  GROUPS.forEach(function (g) {
    var list = accounts().filter(g.f);
    if (!list.length) return;
    var t = 0;
    var body = '';
    list.forEach(function (a) {
      var v = m.values[a.id] || { hkd: 0, cny: 0 }, val = rmb(v, r); t += val;
      var pv = pm ? rmb(pm.values[a.id], pm.rate) : null;
      var dl = pv === null ? null : disp(val - pv, r);
      var zero = !v.hkd && !v.cny;
      body += '<tr' + (zero ? ' class="faint"' : '') + '><td>' + esc(a.name) +
        (m.carried.indexOf(a.id) >= 0 ? '<span class="tag warn">沿用</span>' : '') + '</td>' +
        '<td>' + (a.ccy === 'CNY' ? '<span class="faint">—</span>' : fmt(v.hkd, 0)) + '</td>' +
        '<td>' + (a.ccy === 'HKD' ? '<span class="faint">—</span>' : fmt(v.cny, 0)) + '</td>' +
        '<td class="' + cls(val) + '">' + money(disp(val, r), 0) + '</td>' +
        '<td class="' + (dl === null || !dl ? 'faint' : cls(dl)) + '">' + (dl === null ? '—' : (dl === 0 ? '—' : signed(dl, 0))) + '</td></tr>';
    });
    h += '<tr class="grp"><td colspan="5">' + esc(g.label) + '</td></tr>' + body +
      '<tr class="sum"><td>小计</td><td></td><td></td><td class="' + cls(t) + '">' + money(disp(t, r), 0) + '</td><td></td></tr>';
  });
  h += '</tbody></table></div>';
  return h;
}
function miniStat(label, val, dl, color, sub) {
  return '<div><div class="mini-lbl"><i class="dot" style="background:' + color + '"></i>' + label + '</div>' +
    '<div class="mini-val ' + (val < 0 ? 'neg' : '') + '">' + money(val, 0) + '</div>' +
    '<div class="mini-sub">' + (sub ? sub + (dl !== null ? ' · ' : '') : '') +
    (dl !== null ? '<span class="' + cls(dl) + '">' + signed(dl, 0) + '</span>' : (sub ? '' : '&nbsp;')) + '</div></div>';
}
function tile(k, v, dl, sub, invert) {
  var c = invert ? (v > 0 ? 'neg' : '') : (v < 0 ? 'neg' : '');
  var dc = invert ? (dl > 0 ? 'neg' : dl < 0 ? 'pos' : 'faint') : cls(dl);
  return '<div class="card tile"><div class="k">' + k + '</div><div class="v ' + c + '">' + money(v, 0) + '</div>' +
    '<div class="d">' + esc(sub) + (dl !== null && dl !== undefined ? ' · <span class="' + dc + '">' + signed(dl, 0) + '</span>' : '') + '</div></div>';
}

var GROUPS = [
  { label: '内地 · 储蓄 / 现金', f: function (a) { return a.region === 'cn' && a.kind === 'savings'; } },
  { label: '内地 · 信用卡 / 负债', f: function (a) { return a.region === 'cn' && a.kind === 'credit'; } },
  { label: '内地 · 待入账', f: function (a) { return a.region === 'cn' && a.kind === 'receivable'; } },
  { label: '香港 · 储蓄 / 现金', f: function (a) { return a.region === 'hk' && a.kind === 'savings'; } },
  { label: '香港 · 信用卡 / 负债', f: function (a) { return a.region === 'hk' && a.kind === 'credit'; } },
  { label: '香港 · 待入账', f: function (a) { return a.region === 'hk' && a.kind === 'receivable'; } },
  { label: '投资 · 港股', f: function (a) { return a.kind === 'invest'; } }
];

/* ---------------- 录入 ---------------- */
function renderEntry() {
  var m = curMonth();
  if (!m) return '<div class="card empty">还没有月份。<br><br><button class="btn" data-act="newmonth">新建一个月份</button></div>';
  var r = m.rate;
  var h = '<div class="card" style="margin-top:20px;padding:14px 16px" class="row">' +
    '<div class="row">' +
    '<div><div class="mini-lbl">统计日期</div><input type="date" id="mDate" value="' + esc(m.date) + '" style="width:160px"></div>' +
    '<div><div class="mini-lbl">汇率 1 HKD = ? CNY</div><input type="text" id="mRate" value="' + r + '" style="width:110px"></div>' +
    '<div class="spacer" style="flex:1"></div>' +
    '<button class="btn" data-act="newmonth">＋ 新建月份</button>' +
    '<button class="btn ghost" data-act="copyprev">沿用上月全部数值</button>' +
    '<button class="btn danger" data-act="delmonth">删除本月</button>' +
    '</div></div>';

  h += '<div class="notice" style="background:var(--panel2);border-color:var(--line);color:var(--muted)">' +
    '输入框支持算式：直接填 <b>42162-80000</b>（可用额度 − 总额度）或 <b>1370+786+700</b>，回车即可算出结果。' +
    '信用卡一栏 <b>负数 = 欠款</b>，正数 = 溢缴款。</div>';

  var secs = [
    { label: '内地 · 储蓄 / 现金', f: function (a) { return a.region === 'cn' && a.kind === 'savings'; }, mode: 'cn' },
    { label: '内地 · 信用卡 / 负债', f: function (a) { return a.region === 'cn' && a.kind === 'credit'; }, mode: 'cn', credit: true },
    { label: '内地 · 待入账 / 报销', f: function (a) { return a.region === 'cn' && a.kind === 'receivable'; }, mode: 'cn' },
    { label: '香港 · 储蓄 / 现金', f: function (a) { return a.region === 'hk' && a.kind === 'savings'; }, mode: 'hk' },
    { label: '香港 · 信用卡 / 负债', f: function (a) { return a.region === 'hk' && a.kind === 'credit'; }, mode: 'hk', credit: true },
    { label: '香港 · 待入账 / 报销', f: function (a) { return a.region === 'hk' && a.kind === 'receivable'; }, mode: 'hk' },
    { label: '投资 · 港股账户（每月手动填市值）', f: function (a) { return a.kind === 'invest'; }, mode: 'stock' }
  ];

  secs.forEach(function (sec) {
    var list = accounts().filter(sec.f);
    if (!list.length) return;
    h += '<div class="sec-title">' + esc(sec.label) + '</div><div class="card tblwrap"><table><thead><tr><th style="min-width:150px">账户</th>';
    if (sec.mode === 'cn') { if (sec.credit) h += '<th style="width:120px">总额度</th><th style="width:130px">可用额度</th>'; h += '<th style="width:150px">余额 CNY</th><th style="width:110px">上月</th>'; }
    else if (sec.mode === 'hk') { h += '<th style="width:140px">港币 HKD</th><th style="width:150px">香港人民币 CNY</th><th style="width:120px">折合 CNY</th><th style="width:110px">上月</th>'; }
    else { h += '<th style="width:150px">市值 HKD</th><th style="width:120px">折合 CNY</th><th style="width:110px">上月</th>'; }
    h += '</tr></thead><tbody>';
    var pm = prevMonth(m.id);
    list.forEach(function (a) {
      var v = m.values[a.id] || { hkd: 0, cny: 0 };
      var pv = pm ? rmb(pm.values[a.id], pm.rate) : null;
      var carried = m.carried.indexOf(a.id) >= 0;
      h += '<tr data-acc="' + a.id + '"><td>' + esc(a.name) +
        (carried ? '<span class="tag warn">沿用</span>' : '') +
        (a.note ? '<div class="faint" style="font-size:11px">' + esc(a.note) + '</div>' : '') + '</td>';
      if (sec.mode === 'cn') {
        if (sec.credit) {
          h += '<td><input type="text" data-f="limit" data-acc="' + a.id + '" value="' + (a.limit == null ? '' : a.limit) + '" placeholder="—"></td>';
          h += '<td><input type="text" data-f="avail" data-acc="' + a.id + '" value="" placeholder="' + (a.limit == null ? '先填额度' : '填可用额度') + '"' + (a.limit == null ? ' disabled' : '') + '></td>';
        }
        h += '<td><input type="text" data-f="cny" data-acc="' + a.id + '" value="' + (v.cny || '') + '" placeholder="0"></td>';
      } else if (sec.mode === 'hk') {
        h += '<td><input type="text" data-f="hkd" data-acc="' + a.id + '" value="' + (v.hkd || '') + '" placeholder="0"></td>';
        h += '<td><input type="text" data-f="cny" data-acc="' + a.id + '" value="' + (v.cny || '') + '" placeholder="0"></td>';
        h += '<td class="calc" data-acc="' + a.id + '">' + fmt(rmb(v, r), 0) + '</td>';
      } else {
        h += '<td><input type="text" data-f="hkd" data-acc="' + a.id + '" value="' + (v.hkd || '') + '" placeholder="0"></td>';
        h += '<td class="calc" data-acc="' + a.id + '">' + fmt(rmb(v, r), 0) + '</td>';
      }
      h += '<td class="faint">' + (pv === null ? '—' : fmt(pv, 0)) + '</td></tr>';
    });
    h += '</tbody></table></div>';
  });

  h += '<div class="stickyfoot" id="foot"></div>';
  return h;
}
function renderFoot() {
  var el = $('#foot'); if (!el) return;
  var m = curMonth(); if (!m) return;
  var M = metrics(m), r = M.rate;
  var items = [
    ['内地现金流', M.cn.cash], ['内地总余额', M.cn.total],
    ['香港现金流', M.hk.cash], ['香港总余额', M.hk.total],
    ['港股', M.invest], ['总资产', M.total]
  ];
  el.innerHTML = items.map(function (it, i) {
    return '<div class="sf"' + (i === items.length - 1 ? ' style="margin-left:auto;text-align:right"' : '') + '><div class="k">' + it[0] + '</div>' +
      '<div class="v ' + (it[1] < 0 ? 'neg' : '') + '"' + (i === items.length - 1 ? ' style="font-size:19px"' : '') + '>' + money(disp(it[1], r), 0) + '</div></div>';
  }).join('');
}

/* ---------------- 账户管理 ---------------- */
function renderAccounts() {
  var h = '<div class="sec-title">账户管理</div>' +
    '<div class="notice" style="background:var(--panel2);border-color:var(--line);color:var(--muted);margin-top:0">' +
    '改名、增删、调整顺序都在这里。<b>停用</b>的账户不参与统计、也不在录入页显示，但历史数据保留。' +
    '账户「类型」决定它怎么进汇总：<b>储蓄</b>算现金流；<b>信用卡</b>是负债（负数）；<b>投资</b>单独统计；<b>待入账</b>计入总资产但不算现金流。</div>' +
    '<div class="row" style="margin:14px 0"><button class="btn" data-act="addacc">＋ 新增账户</button></div>' +
    '<div class="card tblwrap"><table><thead><tr>' +
    '<th style="min-width:170px">名称</th><th style="width:100px">地区</th><th style="width:120px">类型</th><th style="width:110px">币种</th>' +
    '<th style="width:110px">额度</th><th style="min-width:150px">备注</th><th style="width:70px">启用</th><th style="width:120px">操作</th>' +
    '</tr></thead><tbody>';
  S.accounts.forEach(function (a, i) {
    h += '<tr data-acc="' + a.id + '">' +
      '<td><input type="text" class="lft" data-af="name" data-acc="' + a.id + '" value="' + esc(a.name) + '"></td>' +
      '<td>' + sel('region', a.id, a.region, [['cn', '内地'], ['hk', '香港']]) + '</td>' +
      '<td>' + sel('kind', a.id, a.kind, [['savings', '储蓄'], ['credit', '信用卡'], ['invest', '投资'], ['receivable', '待入账']]) + '</td>' +
      '<td>' + sel('ccy', a.id, a.ccy, [['CNY', '仅人民币'], ['HKD', '仅港币'], ['BOTH', '港币+人民币']]) + '</td>' +
      '<td><input type="text" data-af="limit" data-acc="' + a.id + '" value="' + (a.limit == null ? '' : a.limit) + '" placeholder="—"></td>' +
      '<td><input type="text" class="lft" data-af="note" data-acc="' + a.id + '" value="' + esc(a.note) + '"></td>' +
      '<td><input type="checkbox" data-af="active" data-acc="' + a.id + '"' + (a.active ? ' checked' : '') + ' style="width:auto"></td>' +
      '<td><button class="btn ghost sm" data-act="up" data-acc="' + a.id + '"' + (i === 0 ? ' disabled' : '') + '>↑</button> ' +
      '<button class="btn ghost sm" data-act="down" data-acc="' + a.id + '"' + (i === S.accounts.length - 1 ? ' disabled' : '') + '>↓</button> ' +
      '<button class="btn danger sm" data-act="delacc" data-acc="' + a.id + '">删</button></td></tr>';
  });
  return h + '</tbody></table></div>';
}
function sel(field, id, val, opts) {
  return '<select class="inp" data-af="' + field + '" data-acc="' + id + '">' + opts.map(function (o) {
    return '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('') + '</select>';
}

/* ---------------- 渲染 / 事件 ---------------- */
function render() {
  renderStatus();
  if (!S) return renderOnboarding();
  var ms = S.months;
  if (!month(ui.monthId)) ui.monthId = ms.length ? ms[ms.length - 1].id : null;
  $('#monthSel').innerHTML = ms.slice().reverse().map(function (m) {
    return '<option value="' + m.id + '"' + (m.id === ui.monthId ? ' selected' : '') + '>' + m.date + '</option>';
  }).join('') || '<option>无数据</option>';
  var cm = curMonth();
  $('#hdDate').textContent = cm ? cm.date : '';
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('on', b.dataset.tab === ui.tab); });
  Array.prototype.forEach.call(document.querySelectorAll('#ccySeg button'), function (b) { b.classList.toggle('on', b.dataset.ccy === ui.ccy); });
  view.innerHTML = ui.tab === 'overview' ? renderOverview() : ui.tab === 'entry' ? renderEntry() : renderAccounts();
  if (ui.tab === 'entry') renderFoot();
}

/* 服务器上还没有这个用户的数据时的首屏 */
function renderOnboarding() {
  $('#monthSel').innerHTML = '<option>—</option>';
  $('#hdDate').textContent = '';
  var n = (window.SEED && window.SEED.accounts ? window.SEED.accounts.length : 0);
  view.innerHTML = '<div class="card onboard"><h2>欢迎，' + esc(Store.user && Store.user.name ? Store.user.name : '') + '</h2>' +
    '<p>你的账号下还没有数据。<br>可以从内置的 ' + n + ' 个账户模板开始，或者直接导入以前导出的备份 JSON。</p>' +
    '<div class="row"><button class="btn" data-act="startfresh">用账户模板开始</button>' +
    '<button class="btn ghost" data-act="import">导入备份 JSON</button></div></div>';
}

document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-tab]');
  if (t) { ui.tab = t.dataset.tab; render(); return; }
  var c = e.target.closest('#ccySeg button');
  if (c) { ui.ccy = c.dataset.ccy; save(); render(); return; }
  var a = e.target.closest('[data-act]');
  if (a) { act(a.dataset.act, a.dataset.acc, e); return; }
});
$('#monthSel').addEventListener('change', function (e) { ui.monthId = e.target.value; render(); });
$('#themeBtn').addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  if (next) document.documentElement.setAttribute('data-theme', next); else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem(KEY + ':theme', next); } catch (err) { }
});
(function () { try { var t = localStorage.getItem(KEY + ':theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) { } })();

/* 输入处理 */
view.addEventListener('change', onInput);
view.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var el = e.target;
  if (!el || el.tagName !== 'INPUT') return;
  e.preventDefault();
  onInput({ target: el });
  el.blur();
});
function onInput(e) {
  var el = e.target, m = curMonth();
  if (el.id === 'mDate') { m.date = el.value; m.id = el.value.slice(0, 7); ui.monthId = m.id; S.months.sort(function (x, y) { return x.id < y.id ? -1 : 1; }); save(); render(); return; }
  if (el.id === 'mRate') { var rr = parseNum(el.value); if (!isNaN(rr) && rr > 0) { m.rate = rr; save(); render(); } return; }

  var af = el.dataset.af, id = el.dataset.acc;
  if (af && id) {
    var acc = S.accounts.find(function (x) { return x.id === id; });
    if (!acc) return;
    if (af === 'active') acc.active = el.checked;
    else if (af === 'limit') { var L = parseNum(el.value); acc.limit = el.value.trim() === '' || isNaN(L) ? null : L; }
    else if (af === 'name' || af === 'note') acc[af] = el.value;
    else acc[af] = el.value;
    if (af === 'ccy' || af === 'region' || af === 'kind') normalize(S);
    save(); render(); return;
  }

  var f = el.dataset.f;
  if (f && id && m) {
    var v = m.values[id] || (m.values[id] = { hkd: 0, cny: 0 });
    var acct = S.accounts.find(function (x) { return x.id === id; });
    /* 「总额度」改的是账户属性，不是当月余额 —— 改完要重算同一行的可用额度 */
    if (f === 'limit') {
      if (!acct) return;
      var L = parseNum(el.value);
      if (isNaN(L)) { el.style.borderColor = 'var(--neg)'; return; }
      el.style.borderColor = '';
      acct.limit = el.value.trim() === '' ? null : L;
      el.value = acct.limit == null ? '' : acct.limit;
      save();
      var lrow = el.closest('tr');
      var avEl = lrow && lrow.querySelector('[data-f="avail"]');
      if (avEl) {
        avEl.disabled = acct.limit == null;
        avEl.placeholder = acct.limit == null ? '先填额度' : '填可用额度';
        if (acct.limit != null && avEl.value.trim() !== '') applyAvail(avEl, acct, m, lrow);
      }
      return;
    }
    if (f === 'avail') {
      if (!acct || acct.limit == null) return;
      if (el.value.trim() === '') { el.style.borderColor = ''; return; }
      applyAvail(el, acct, m, el.closest('tr'));
      return;
    }
    var n = parseNum(el.value);
    if (isNaN(n)) { el.style.borderColor = 'var(--neg)'; return; }
    el.style.borderColor = '';
    v[f] = n;
    var ci = m.carried.indexOf(id); if (ci >= 0) m.carried.splice(ci, 1);
    save();
    var row = el.closest('tr');
    var calc = row && row.querySelector('.calc');
    if (calc) calc.textContent = fmt(rmb(v, m.rate), 0);
    var inp = row && row.querySelector('[data-f="' + f + '"]'); if (inp) inp.value = v[f] || '';
    /* 直接改了余额，就把「可用额度」清空，免得两个数对不上 */
    if (f === 'cny' && row) { var stale = row.querySelector('[data-f="avail"]'); if (stale) stale.value = ''; }
    renderFoot();
    if (row) { var tg = row.querySelector('.tag.warn'); if (tg) tg.remove(); }
    return;
  }
}

/* 可用额度 → 余额：余额 = 可用额度 − 总额度（欠款为负） */
function applyAvail(el, acct, m, row) {
  var av = parseNum(el.value);
  if (isNaN(av)) { el.style.borderColor = 'var(--neg)'; return false; }
  el.style.borderColor = '';
  el.value = av;
  var v = m.values[acct.id] || (m.values[acct.id] = { hkd: 0, cny: 0 });
  v.cny = Math.round((av - acct.limit) * 100) / 100;
  var ci = m.carried.indexOf(acct.id); if (ci >= 0) m.carried.splice(ci, 1);
  save();
  if (row) {
    var ic = row.querySelector('[data-f="cny"]'); if (ic) ic.value = v.cny || '';
    var calc = row.querySelector('.calc'); if (calc) calc.textContent = fmt(rmb(v, m.rate), 0);
    var tg = row.querySelector('.tag.warn'); if (tg) tg.remove();
  }
  renderFoot();
  return true;
}

/* 动作 */
function act(name, accId, ev) {
  if (name === 'import') { $('#fileInput').click(); return; }
  if (name === 'logout') {
    if (!confirm('退出登录？未同步的改动会先保存。')) return;
    Store.flush().then(function () { location.href = 'auth/logout'; });
    return;
  }
  if (name === 'startfresh') {
    S = normalize(JSON.parse(JSON.stringify(window.SEED)));
    ui.monthId = S.months.length ? S.months[S.months.length - 1].id : null;
    ui.tab = S.months.length ? 'overview' : 'entry';
    save(); render();
    if (!S.months.length) newMonth();
    return;
  }
  if (!S) return;
  var m = curMonth();
  if (name === 'newmonth') return newMonth();
  if (name === 'copyprev') {
    var pm = prevMonth(m.id);
    if (!pm) return alert('没有上一个月的数据');
    if (!confirm('用上月（' + pm.date + '）的全部数值覆盖本月？')) return;
    m.values = JSON.parse(JSON.stringify(pm.values)); m.rate = pm.rate; m.carried = [];
    save(); render(); return;
  }
  if (name === 'delmonth') {
    if (!confirm('删除 ' + m.date + ' 这个月的全部数据？不可撤销。')) return;
    S.months = S.months.filter(function (x) { return x.id !== m.id; });
    ui.monthId = S.months.length ? S.months[S.months.length - 1].id : null;
    save(); render(); return;
  }
  if (name === 'addacc') {
    var id = 'acc_' + Date.now().toString(36);
    S.accounts.push({ id: id, name: '新账户', region: 'cn', kind: 'savings', ccy: 'CNY', limit: null, note: '', active: true });
    normalize(S); save(); render();
    var el = document.querySelector('[data-af="name"][data-acc="' + id + '"]'); if (el) { el.focus(); el.select(); }
    return;
  }
  if (name === 'delacc') {
    var acc = S.accounts.find(function (x) { return x.id === accId; });
    if (!confirm('删除账户「' + acc.name + '」？所有月份中它的数据都会一并删除。\n\n若只是暂时不用，建议改为「停用」。')) return;
    S.accounts = S.accounts.filter(function (x) { return x.id !== accId; });
    S.months.forEach(function (x) { delete x.values[accId]; x.carried = x.carried.filter(function (c) { return c !== accId; }); });
    save(); render(); return;
  }
  if (name === 'up' || name === 'down') {
    var i = S.accounts.findIndex(function (x) { return x.id === accId; });
    var j = name === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= S.accounts.length) return;
    var tmp = S.accounts[i]; S.accounts[i] = S.accounts[j]; S.accounts[j] = tmp;
    save(); render(); return;
  }
  if (name === 'export') return exportJSON();
  if (name === 'forcesync') {
    if (!S || Store.mode !== 'server') return;
    if (!confirm('用这台设备上的数据覆盖服务器上的版本？服务器上的当前版本会被替换。')) return;
    setStatus('saving');
    fetch('api/data', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pf' },
      body: JSON.stringify({ data: S, force: true })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { Store.rev = j.rev; setStatus('saved'); })
      .catch(function (e) { setStatus('offline'); alert('同步失败：' + e.message); });
    return;
  }
  if (name === 'reset') {
    if (!confirm(resetLabel() + '？当前所有改动会丢失。')) return;
    S = normalize(JSON.parse(JSON.stringify(window.SEED)));
    ui.monthId = S.months.length ? S.months[S.months.length - 1].id : null;
    save(); render(); return;
  }
}
function resetLabel() { return (window.SEED && window.SEED.months && window.SEED.months.length) ? '恢复为内置的初始数据' : '清空全部月份，只保留账户模板'; }

function newMonth() {
  var last = S.months[S.months.length - 1];
  var d = new Date();
  var def = d.toISOString().slice(0, 10);
  var body = '<h3>新建月份</h3>' +
    '<div class="fld"><label>统计日期</label><input type="date" id="nmDate" value="' + def + '"></div>' +
    '<div class="fld"><label>汇率 1 HKD = ? CNY</label><input type="text" id="nmRate" value="' + (last ? last.rate : 0.89) + '"></div>' +
    (last ? '<div class="fld"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="nmCopy" checked style="width:auto"> 以 ' + last.date + ' 的数值为起点（推荐，只改变动的账户）</label></div>' : '') +
    '<div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" id="nmCancel">取消</button><button class="btn" id="nmOk">创建</button></div>';
  openDlg(body);
  $('#nmCancel').onclick = function () { $('#dlg').close(); };
  $('#nmOk').onclick = function () {
    var date = $('#nmDate').value, id = date.slice(0, 7);
    if (!date) return alert('请选择日期');
    if (month(id)) return alert(id + ' 已存在，请直接在「录入」页修改。');
    var rate = parseNum($('#nmRate').value) || (last ? last.rate : 0.89);
    var copy = $('#nmCopy') && $('#nmCopy').checked;
    var values = {};
    S.accounts.forEach(function (a) {
      values[a.id] = copy && last && last.values[a.id] ? { hkd: last.values[a.id].hkd, cny: last.values[a.id].cny } : { hkd: 0, cny: 0 };
      if (copy && a.kind === 'receivable') values[a.id] = { hkd: 0, cny: 0 };
    });
    S.months.push({ id: id, date: date, rate: rate, values: values, carried: copy && last ? S.accounts.map(function (a) { return a.id; }).filter(function (x) { var v = values[x]; return v.hkd || v.cny; }) : [] });
    S.months.sort(function (x, y) { return x.id < y.id ? -1 : 1; });
    ui.monthId = id; ui.tab = 'entry'; save(); $('#dlg').close(); render();
  };
}
function openDlg(html) { $('#dlgBody').innerHTML = html; $('#dlg').showModal(); }

/* 数据导入导出 */
function exportJSON() {
  if (!S) return;
  var blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
  var url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = '资金看板备份-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
$('#fileInput').addEventListener('change', function (e) {
  var f = e.target.files[0]; if (!f) return;
  var fr = new FileReader();
  fr.onload = function () {
    try {
      var d = JSON.parse(fr.result);
      if (!d.accounts || !d.months) throw new Error('文件格式不对');
      S = normalize(d); ui.monthId = S.months.length ? S.months[S.months.length - 1].id : null;
      save(); render(); alert('导入成功：' + S.accounts.length + ' 个账户，' + S.months.length + ' 个月份。');
    } catch (err) { alert('导入失败：' + err.message); }
    e.target.value = '';
  };
  fr.readAsText(f);
});
$('#menuBtn').addEventListener('click', function (e) {
  var old = document.querySelector('.menu'); if (old) { old.remove(); return; }
  var d = document.createElement('div'); d.className = 'menu';
  d.innerHTML = '<button data-act="export">导出备份 (JSON)</button>' +
    '<button data-act="import">导入备份</button>' +
    (Store.mode === 'server' ? '<button data-act="forcesync">强制同步到服务器</button>' : '') +
    '<button data-act="reset" style="color:var(--neg)">' + resetLabel() + '</button>';
  document.body.appendChild(d);
  var r = e.currentTarget.getBoundingClientRect();
  d.style.top = (r.bottom + 6) + 'px';
  d.style.left = Math.max(8, r.right - d.offsetWidth) + 'px';
  setTimeout(function () {
    document.addEventListener('click', function h(ev) {
      if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', h); }
      else { d.remove(); document.removeEventListener('click', h); }
    });
  }, 0);
});

/* 页面藏起来 / 关闭前，把还在防抖队列里的改动推上去 */
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') Store.flush(); });
window.addEventListener('pagehide', function () { Store.flush(); });

/* ---------------- 启动 ---------------- */
function adopt(data) {
  S = normalize(data);
  ui.monthId = S.months.length ? S.months[S.months.length - 1].id : null;
  ui.ccy = S.baseCcy || 'CNY';
}
function boot() {
  renderStatus();
  Store.probe()
    .then(function () { return Store.fetchState(); })
    .then(function (data) {
      if (data) adopt(data);
      else if (Store.mode === 'local') adopt(JSON.parse(JSON.stringify(window.SEED)));
      else S = null;              // 服务器模式且服务器上没数据 → 走首屏引导
      render();
      if (Store.mode === 'server' && S) setStatus('saved');
    })
    .catch(function (e) {
      if (e && e.unauth) { location.href = e.loginUrl || 'auth/login'; return; }
      console.error('加载失败，改用本地缓存', e);
      adopt(readCache(Store.cacheKey()) || JSON.parse(JSON.stringify(window.SEED)));
      render();
      setStatus('offline');
    });
}
boot();
})();
