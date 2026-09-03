/* 生成演示数据 src/data/demo-months.json
 *
 * 全是编的，只为让演示页面的图表有内容可看。数字写死不随机，
 * 这样每次构建产物一致，diff 才有意义。
 *
 * 用法：node src/data/make-demo.js
 */
const fs = require('fs');
const path = require('path');

const MONTHS = ['2026-03-05', '2026-04-04', '2026-05-06', '2026-06-03', '2026-07-05', '2026-08-04'];
const RATES = [0.92, 0.92, 0.91, 0.93, 0.92, 0.92];

// 每个账户 6 个月的值。人民币账户填一列数；港币账户填 [港币, 港币里的人民币子账户]
const CNY = {
  cn_sv_boc: [12000, 12400, 13100, 13100, 14200, 15600],
  cn_sv_icbc: [8500, 8500, 9200, 9200, 9200, 10400],
  cn_sv_cmb: [26000, 24800, 27600, 31200, 30100, 34800],
  cn_sv_ccb: [4200, 4260, 4260, 4390, 4390, 4520],
  cn_sv_wechat: [1800, 960, 2340, 1120, 3050, 1680],
  cn_sv_alipay: [900, 1350, 620, 1880, 740, 1210],

  cn_cc_cmb: [-32000, -38600, -29400, -24800, -31200, -22600],
  cn_cc_citic: [-8600, -5200, -9800, -7400, -4100, -6300],
  cn_cc_huabei: [-6000, -6000, -4000, -4000, -2000, -2000],

  cn_rc_pending: [0, 3200, 3200, 0, 5400, 0]
};

// [港币, 香港人民币]
const HK = {
  hk_sv_hsbc: [[42000, 3000], [39500, 3000], [44800, 1500], [48200, 1500], [46100, 4200], [52400, 4200]],
  hk_sv_bochk: [[15000, 0], [16200, 0], [14100, 0], [17800, 0], [19400, 0], [18900, 0]],
  hk_sv_hangseng: [[6800, 0], [6800, 0], [7150, 0], [7150, 0], [7420, 0], [7420, 0]],
  hk_sv_za: [[2400, 0], [3100, 0], [2850, 0], [4200, 0], [3900, 0], [5100, 0]],
  hk_sv_octopus: [[380, 0], [220, 0], [460, 0], [310, 0], [540, 0], [290, 0]],
  hk_sv_payme: [[120, 0], [340, 0], [90, 0], [260, 0], [180, 0], [420, 0]],

  hk_cc_hsbc: [[-9800, 0], [-12400, -1200], [-7600, 0], [-11200, -800], [-8400, 0], [-6900, 0]],
  hk_cc_bochk: [[-2200, 0], [-1800, 0], [-3400, 0], [-2100, 0], [-2900, 0], [-1600, 0]],

  hk_iv_stock: [[96000, 0], [101500, 0], [98200, 0], [112400, 0], [118900, 0], [126300, 0]]
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

// 顺手打印一下总资产，好确认曲线是不是好看
for (const m of months) {
  let cash = 0, debt = 0, inv = 0, recv = 0;
  for (const a of accounts) {
    const v = m.values[a.id];
    const rmb = v.hkd * m.rate + v.cny;
    if (a.kind === 'savings') cash += rmb;
    else if (a.kind === 'credit') debt += rmb;
    else if (a.kind === 'invest') inv += v.hkd * m.rate;
    else recv += rmb;
  }
  console.log(m.date, ' 现金 ' + Math.round(cash).toString().padStart(7),
    ' 负债 ' + Math.round(debt).toString().padStart(7),
    ' 港股 ' + Math.round(inv).toString().padStart(7),
    ' 总资产 ' + Math.round(cash + debt + inv + recv).toString().padStart(7));
}
