/* 生成演示数据 src/data/demo-months.json
 *
 * 全是编的，只为让演示页面的图表有内容可看。数字写死不随机，
 * 这样每次构建产物一致，diff 才有意义。
 *
 * 设计意图：总资产走一条「从欠着钱到还清转正」的弧线，
 * 落在 -20000 ~ +20000 之间 —— 既贴近多数人的真实量级，
 * 也能顺带展示跨零时那条虚线和负数配色。
 *
 * 用法：node src/data/make-demo.js
 */
const fs = require('fs');
const path = require('path');

const MONTHS = ['2026-03-05', '2026-04-04', '2026-05-06', '2026-06-03', '2026-07-05', '2026-08-04'];
const RATES = [0.92, 0.92, 0.91, 0.93, 0.92, 0.92];

// 人民币账户填一列数；港币账户填 [港币, 港币账户里的人民币子账户]
const CNY = {
  cn_sv_boc: [2100, 2400, 2000, 2900, 3400, 4100],
  cn_sv_icbc: [1200, 1200, 1600, 1600, 1600, 2100],
  cn_sv_cmb: [4200, 3400, 4800, 5900, 6400, 7600],
  cn_sv_ccb: [800, 830, 830, 880, 880, 920],
  cn_sv_wechat: [320, 180, 480, 230, 610, 350],
  cn_sv_alipay: [170, 260, 120, 360, 150, 240],

  // 一路把欠款还下去
  cn_cc_cmb: [-26000, -28600, -24000, -19000, -15000, -7200],
  cn_cc_citic: [-4200, -2800, -5100, -3400, -1900, -2600],
  cn_cc_huabei: [-6000, -6000, -4000, -4000, -2000, -2000],

  cn_rc_pending: [0, 1400, 1400, 0, 2200, 0]
};

const HK = {
  hk_sv_hsbc: [[3200, 400], [2900, 400], [3600, 200], [4100, 200], [3800, 600], [4700, 600]],
  hk_sv_bochk: [[1200, 0], [1350, 0], [1150, 0], [1500, 0], [1680, 0], [1600, 0]],
  hk_sv_hangseng: [[560, 0], [560, 0], [610, 0], [610, 0], [640, 0], [640, 0]],
  hk_sv_za: [[210, 0], [270, 0], [240, 0], [360, 0], [330, 0], [440, 0]],
  hk_sv_octopus: [[70, 0], [40, 0], [90, 0], [60, 0], [110, 0], [50, 0]],
  hk_sv_payme: [[20, 0], [60, 0], [10, 0], [50, 0], [30, 0], [80, 0]],

  hk_cc_hsbc: [[-950, 0], [-1240, -200], [-720, 0], [-1080, -150], [-800, 0], [-600, 0]],
  hk_cc_bochk: [[-210, 0], [-170, 0], [-330, 0], [-200, 0], [-270, 0], [-150, 0]],

  hk_iv_stock: [[6200, 0], [6800, 0], [6300, 0], [7900, 0], [8400, 0], [9600, 0]]
};

const accounts = JSON.parse(fs.readFileSync(path.join(__dirname, 'accounts.json'), 'utf8'));
const ids = new Set(accounts.map(a => a.id));
for (const k of [...Object.keys(CNY), ...Object.keys(HK)]) {
  if (!ids.has(k)) throw new Error('demo 里有 accounts.json 中不存在的账户：' + k);
}
for (const a of accounts) {
  if (!CNY[a.id] && !HK[a.id]) throw new Error('账户没有演示数据：' + a.id);
}

const months = MONTHS.map((date, i) => {
  const values = {};
  for (const a of accounts) {
    if (CNY[a.id]) values[a.id] = { hkd: 0, cny: CNY[a.id][i] };
    else values[a.id] = { hkd: HK[a.id][i][0], cny: HK[a.id][i][1] };
  }
  return { id: date.slice(0, 7), date, rate: RATES[i], values, carried: [] };
});

fs.writeFileSync(path.join(__dirname, 'demo-months.json'), JSON.stringify(months, null, 1));

// 打印各口径，确认曲线好看且总资产落在预期区间内
const pad = n => Math.round(n).toLocaleString('zh-CN').padStart(8);
let min = Infinity, max = -Infinity, prev = null;
console.log('   日期        内地现金  内地总额   香港现金  香港总额     港股    总资产      环比');
for (const m of months) {
  let cnCash = 0, cnDebt = 0, cnRecv = 0, hkCash = 0, hkDebt = 0, inv = 0;
  for (const a of accounts) {
    const v = m.values[a.id];
    const rmb = v.hkd * m.rate + v.cny;
    if (a.kind === 'invest') inv += v.hkd * m.rate;
    else if (a.region === 'cn') {
      if (a.kind === 'savings') cnCash += rmb;
      else if (a.kind === 'credit') cnDebt += rmb;
      else cnRecv += rmb;
    } else {
      if (a.kind === 'savings') hkCash += rmb;
      else if (a.kind === 'credit') hkDebt += rmb;
    }
  }
  const cnTotal = cnCash + cnDebt + cnRecv;
  const hkTotal = hkCash + hkDebt + inv;
  const total = cnTotal + hkTotal;
  min = Math.min(min, total); max = Math.max(max, total);
  console.log(' ' + m.date + pad(cnCash) + pad(cnTotal) + pad(hkCash) + pad(hkTotal) + pad(inv) + pad(total) +
    (prev === null ? '         —' : pad(total - prev)));
  prev = total;
}
console.log('\n总资产区间：' + Math.round(min).toLocaleString('zh-CN') + ' ~ ' + Math.round(max).toLocaleString('zh-CN'));
if (min < -20000 || max > 20000) {
  console.log('⚠  超出 -20000 ~ 20000 的目标区间');
  process.exitCode = 1;
}
