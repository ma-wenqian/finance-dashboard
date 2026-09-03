/* 构建：把数据 + app.js 内联进 template.html，产出三份页面。
 *
 *   docs/index.html            演示版 —— 假数据，GitHub Pages 就发这个
 *   server/public/index.html   服务器版 —— 只有账户模板，不含任何金额
 *   private/index.html         本地版 —— 你自己的真实数据（private/ 已 gitignore）
 *                              只有存在 private/seed-real.json 时才生成
 *
 * 分成三份是因为服务器版是多人共用的，页面源码里不该带着任何人的余额；
 * 而演示版要能公开发布。构建末尾会校验这两点。
 *
 * 用法：node src/build.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

new Function(app);   // 语法先过一遍，别把坏代码打进产物

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const accounts = readJSON(path.join(__dirname, 'data', 'accounts.json'));
const demoMonths = readJSON(path.join(__dirname, 'data', 'demo-months.json'));

function build(outFile, seed, label) {
  const scripts = '<script>\nwindow.SEED = ' + JSON.stringify(seed) + ';\n<\/script>\n<script>\n' + app + '<\/script>';
  // 用函数形式的 replacer，避免代码里的 $' / $& 被当成替换模式
  const out = tpl.replace('<!--SCRIPTS-->', () => scripts);
  if (out.indexOf('<!--SCRIPTS-->') >= 0) throw new Error('占位符未替换');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out);
  console.log('  ' + label.padEnd(8) + path.relative(root, outFile).padEnd(26) +
    (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB  ' +
    seed.accounts.length + ' 账户 / ' + seed.months.length + ' 月');
  return out;
}

const base = { version: 1, baseCcy: 'CNY' };

const demoOut = build(path.join(root, 'docs', 'index.html'),
  Object.assign({}, base, { demo: true, accounts, months: demoMonths }), '演示版');

const serverOut = build(path.join(root, 'server', 'public', 'index.html'),
  Object.assign({}, base, { accounts: accounts.map(a => Object.assign({}, a, { limit: null })), months: [] }), '服务器版');

const realPath = path.join(root, 'private', 'seed-real.json');
if (fs.existsSync(realPath)) {
  build(path.join(root, 'private', 'index.html'), readJSON(realPath), '本地版');
} else {
  console.log('  (没有 private/seed-real.json，跳过本地版)');
}

/* 保险：可公开的两份里不能出现真实余额 */
if (fs.existsSync(realPath)) {
  const real = readJSON(realPath);
  // 只挑有辨识度的数值：整百的（5000、20000…）在演示数据和 CSS 里都可能撞上，
  // 拿它们当指纹会误报
  const probes = new Set();
  const distinctive = v => Math.abs(v) >= 1000 && v % 100 !== 0;
  for (const m of real.months) {
    for (const v of Object.values(m.values)) {
      if (distinctive(v.hkd)) probes.add(String(v.hkd));
      if (distinctive(v.cny)) probes.add(String(v.cny));
    }
  }
  for (const [name, html] of [['演示版', demoOut], ['服务器版', serverOut]]) {
    for (const p of probes) {
      if (html.includes('"' + p) || html.includes(':' + p)) {
        throw new Error(name + ' 里出现了真实余额 ' + p + ' —— 构建中止');
      }
    }
  }
  console.log('  校验通过：演示版和服务器版都不含真实余额（比对了 ' + probes.size + ' 个数值）');
}
if (serverOut.match(/"months":\s*\[\s*\{/)) throw new Error('服务器版不该带月份数据');
