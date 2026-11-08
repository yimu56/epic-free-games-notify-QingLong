/**
 * epic-free-games-notify.js 的离线测试台
 *
 * 做法：通过 run({ env, stateFile, request, notify }) 注入依赖，不碰真实网络与真实群聊。
 *   - Epic 接口请求默认回放合成数据，用于精确构造换周、阵容调整等分支；
 *   - 云湖请求一律拦截，只记录请求体并回放成功响应；
 *   - 状态落在系统临时目录，测试结束自动清理；
 *   - 设置 EPIC_RUN_NETWORK_TEST=1 时，额外访问真实 Epic 接口验证可用性。
 *
 * 运行：node test/run-test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = require('../epic-free-games-notify.js');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-ql-test-'));

const BASE_ENV = {
  YUNHU_BOT_TOKEN: 'test-token-abcdef',
  YUNHU_RECV_ID: '10000001',
  QL_NOTIFY_MODE: 'off',
};

let passCount = 0;
let failCount = 0;

function check(name, ok, extra) {
  if (ok) {
    passCount++;
    console.log('  \u2713 ' + name);
  } else {
    failCount++;
    console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function statePath(name) {
  return path.join(TMP_DIR, name + '.json');
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {};
  }
}

/* ---------------- 合成数据 ---------------- */

function game(id, title, cfg) {
  const c = cfg || {};
  const period = (p) =>
    p
      ? [
          {
            promotionalOffers: [
              {
                startDate: p[0],
                endDate: p[1],
                discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 },
              },
            ],
          },
        ]
      : [];

  return {
    title,
    id,
    namespace: 'demo-ns',
    description: c.desc === undefined ? title : c.desc,
    offerType: c.type || 'BASE_GAME',
    productSlug: c.slug || null,
    urlSlug: 'url-' + id,
    seller: { id: 'demo-seller', name: 'Demo Studio' },
    keyImages: [{ type: 'OfferImageWide', url: 'https://cdn.example.com/' + id + '.jpg' }],
    catalogNs: { mappings: [{ pageSlug: c.slug || 'page-' + id, pageType: 'productHome' }] },
    price: {
      totalPrice: {
        discountPrice: 0,
        originalPrice: c.origPrice === undefined ? 5300 : c.origPrice,
        currencyCode: 'CNY',
        fmtPrice: { originalPrice: c.fmtPrice || '\u00a553.00' },
      },
    },
    promotions: {
      promotionalOffers: period(c.current),
      upcomingPromotionalOffers: period(c.upcoming),
    },
  };
}

const resp = (elements) => ({
  data: {
    Catalog: { searchStore: { elements, paging: { count: elements.length, total: elements.length } } },
  },
  extensions: {},
});

const FIX_PROMO = (elements) => [{ match: 'freeGamesPromotions', body: resp(elements) }];

const WEEK_A_START = '2026-10-08T15:00:00.000Z';
const WEEK_A_END = '2026-10-15T15:00:00.000Z';
const WEEK_B_END = '2026-10-22T15:00:00.000Z';
const WEEK_C_END = '2026-10-29T15:00:00.000Z';

const WEEK_A = [
  game('id-a1', '本周游戏甲', { current: [WEEK_A_START, WEEK_A_END], desc: '甲游戏的简介文字' }),
  game('id-a2', '本周游戏乙', { current: [WEEK_A_START, WEEK_A_END] }),
  game('id-a3', '预告游戏丙', { upcoming: [WEEK_A_END, WEEK_B_END] }),
  game('id-dlc', '某游戏季票', { current: [WEEK_A_START, WEEK_A_END], type: 'ADD_ON' }),
];

const WEEK_B = [
  game('id-b1', '次周游戏丁', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b2', '次周游戏戊', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b3', '预告游戏己', { upcoming: [WEEK_B_END, WEEK_C_END] }),
];

const WEEK_B_UPDATED = [
  game('id-b1', '次周游戏丁', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b2', '次周游戏戊', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b4', '追加游戏庚', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b3', '预告游戏己', { upcoming: [WEEK_B_END, WEEK_C_END] }),
];

/* ---------------- 执行器 ---------------- */

function makeRequest(pushes, requestLog, fixtures) {
  return async function request(url, opt) {
    opt = opt || {};
    requestLog.push({ url, method: opt.method || 'GET', headers: opt.headers || {}, data: opt.data });

    if (url.indexOf('chat-go.jwzhd.com') >= 0) {
      pushes.push(JSON.parse(opt.data));
      return { status: 200, responseText: JSON.stringify({ code: 1, data: {}, msg: 'success' }) };
    }

    const fixture = (fixtures || []).find((f) => url.indexOf(f.match) >= 0);
    if (fixture) {
      const body = typeof fixture.body === 'function' ? fixture.body(url) : fixture.body;
      return { status: 200, responseText: JSON.stringify(body) };
    }

    // 未提供 fixture 时走真实网络（仅 Epic 接口会走到这里）
    return SCRIPT.httpRequest(url, opt, SCRIPT.readConfig({}));
  };
}

const realLog = console.log;
async function exec(opts) {
  const o = opts || {};
  const pushes = [];
  const requestLog = [];
  const notifications = [];
  const oldLog = console.log;
  console.log = function () {}; // 静默脚本日志，避免干扰测试输出
  try {
    const result = await SCRIPT.run({
      env: Object.assign({}, BASE_ENV, o.env || {}),
      config: o.config,
      stateFile: o.stateFile,
      request: makeRequest(pushes, requestLog, o.fixtures),
      notify: async (title, text, isError) => notifications.push({ title, text, isError }),
    });
    return { result, pushes, requestLog, notifications };
  } finally {
    console.log = oldLog;
  }
}

/* ---------------- 用例 ---------------- */

(async function main() {
  const MAIN_STATE = statePath('main');

  // ── 场景 1：首次运行 ──
  realLog('\n[场景 1] 首次运行：记录批次但不推送，且过滤非游戏商品');
  const r1 = await exec({ stateFile: MAIN_STATE, fixtures: FIX_PROMO(WEEK_A) });
  realLog('  返回：' + r1.result.split('\n').join('\n  '));
  check('未产生推送', r1.pushes.length === 0, '推送数=' + r1.pushes.length);
  check('返回文案说明已记录', /首次运行，已记录/.test(r1.result), r1.result);
  const s1 = readState(MAIN_STATE);
  check('状态文件已生成且含两个批次', Object.keys(s1.batches || {}).length === 2, JSON.stringify(Object.keys(s1.batches || {})));
  check('ADD_ON 商品已被过滤', !/某游戏季票/.test(r1.result), r1.result);
  check('状态中记录了商店区域', s1.region === 'zh-CN/CN', String(s1.region));
  check('消息时间按北京时间显示', SCRIPT.fmtDateTime(WEEK_A_START, 8) === '10-08 23:00', SCRIPT.fmtDateTime(WEEK_A_START, 8));

  // ── 场景 2：重复执行 ──
  realLog('\n[场景 2] 数据未变化：不应重复推送');
  const r2 = await exec({ stateFile: MAIN_STATE, fixtures: FIX_PROMO(WEEK_A) });
  check('未产生推送', r2.pushes.length === 0, '推送数=' + r2.pushes.length);
  check('返回文案为无变化', (r2.result.match(/无变化/g) || []).length === 2, r2.result);

  // ── 场景 3：换周 ──
  realLog('\n[场景 3] 进入新一周：应推送本周免费与下周预告两条');
  const r3 = await exec({ stateFile: MAIN_STATE, fixtures: FIX_PROMO(WEEK_B) });
  realLog('  返回：' + r3.result.split('\n').join('\n  '));
  check('推送了 2 条', r3.pushes.length === 2, '推送数=' + r3.pushes.length);
  const p3 = r3.pushes;
  check('第一条为本周免费', p3.length === 2 && /本周免费游戏/.test(p3[0].content.text), p3.length ? p3[0].content.text.split('\n')[0] : '');
  check('第二条为下周预告', p3.length === 2 && /下周免费游戏预告/.test(p3[1].content.text), p3.length === 2 ? p3[1].content.text.split('\n')[0] : '');
  check('北京时间写入消息标题', p3.length === 2 && /10-15 23:00 ~ 10-22 23:00/.test(p3[0].content.text), p3.length ? p3[0].content.text.split('\n')[0] : '');
  check('本周批次含两款游戏', p3.length === 2 && /次周游戏丁/.test(p3[0].content.text) && /次周游戏戊/.test(p3[0].content.text));
  check('消息含商店链接', p3.length === 2 && /https:\/\/store\.epicgames\.com\/zh-CN\/p\//.test(p3[0].content.text));
  check('消息含领取入口', p3.length === 2 && p3[0].content.text.indexOf('free-games') >= 0);
  check('消息含原价', p3.length === 2 && p3[0].content.text.indexOf('\u00a553.00') >= 0);
  check('recvId 正确', p3.length === 2 && p3[0].recvId === '10000001');
  check('recvType 正确', p3.length === 2 && p3[0].recvType === 'group');
  check('contentType 为 markdown', p3.length === 2 && p3[0].contentType === 'markdown');
  const pushReq = r3.requestLog.find((x) => x.url.indexOf('chat-go.jwzhd.com') >= 0);
  check('推送 URL 携带 token', !!pushReq && /[?&]token=test-token-abcdef/.test(pushReq.url), pushReq ? pushReq.url : '未发起推送');
  check('Epic 请求走官方接口', r3.requestLog.some((x) => /freeGamesPromotions\?locale=zh-CN&country=CN/.test(x.url)));

  // ── 场景 4：换周后再执行 ──
  realLog('\n[场景 4] 换周后再次执行：不应重复推送');
  const r4 = await exec({ stateFile: MAIN_STATE, fixtures: FIX_PROMO(WEEK_B) });
  check('未产生推送', r4.pushes.length === 0, '推送数=' + r4.pushes.length);

  // ── 场景 5：同批次阵容调整 ──
  realLog('\n[场景 5] 同一批次内追加一款游戏：应推送调整提示');
  const r5 = await exec({ stateFile: MAIN_STATE, fixtures: FIX_PROMO(WEEK_B_UPDATED) });
  realLog('  返回：' + r5.result.split('\n').join('\n  '));
  check('推送了 1 条', r5.pushes.length === 1, '推送数=' + r5.pushes.length);
  check('正文提示阵容有调整', r5.pushes.length === 1 && /免费阵容有调整/.test(r5.pushes[0].content.text));
  check('正文含追加的游戏', r5.pushes.length === 1 && /追加游戏庚/.test(r5.pushes[0].content.text));

  // ── 场景 6：切换商店区域 ──
  realLog('\n[场景 6] 商店区域变更：应视为首次运行重新记录');
  const REGION_STATE = statePath('region');
  const oldBatches = {};
  oldBatches['current|' + WEEK_A_START] = { ids: ['x'], pushedAt: 1 };
  fs.writeFileSync(REGION_STATE, JSON.stringify({ region: 'en-US/US', batches: oldBatches }));
  const r6 = await exec({ stateFile: REGION_STATE, fixtures: FIX_PROMO(WEEK_B) });
  check('未产生推送', r6.pushes.length === 0, '推送数=' + r6.pushes.length);
  check('返回文案为首次运行记录', /首次运行，已记录/.test(r6.result), r6.result);
  check('区域已更新为当前配置', readState(REGION_STATE).region === 'zh-CN/CN');

  // ── 场景 7：配置缺失 ──
  realLog('\n[场景 7] 云湖参数缺失：应跳过执行且不发请求');
  const r7 = await exec({
    stateFile: statePath('missing'),
    env: { YUNHU_BOT_TOKEN: '', YUNHU_RECV_ID: '' },
    fixtures: FIX_PROMO(WEEK_A),
  });
  check('提示环境变量缺失', /环境变量未填写/.test(r7.result), r7.result);
  check('未发起任何网络请求', r7.requestLog.length === 0, '请求数=' + r7.requestLog.length);
  check('失败时触发青龙通知', r7.notifications.length === 1 && r7.notifications[0].isError === true, JSON.stringify(r7.notifications));

  // ── 场景 8：环境变量覆盖与别名 ──
  realLog('\n[场景 8] 青龙环境变量：别名、布尔值、区域、首次推送');
  const cfg = SCRIPT.readConfig({
    EPIC_YUNHU_BOT_TOKEN: 'alias-token',
    EPIC_YUNHU_RECV_ID: 'alias-id',
    EPIC_COUNTRY: 'US',
    EPIC_LOCALE: 'en-US',
    PUSH_UPCOMING: 'false',
    DESC_MAX_LEN: '66',
    EPIC_TZ_OFFSET: '0',
    QL_NOTIFY_MODE: 'always',
  });
  check('token 别名生效', cfg.YUNHU_BOT_TOKEN === 'alias-token', cfg.YUNHU_BOT_TOKEN);
  check('接收者别名生效', cfg.YUNHU_RECV_ID === 'alias-id', cfg.YUNHU_RECV_ID);
  check('区域覆盖生效', cfg.COUNTRY === 'US' && cfg.LOCALE === 'en-US');
  check('布尔值解析生效', cfg.PUSH_UPCOMING === false && cfg.PUSH_CURRENT === true);
  check('数值解析生效', cfg.DESC_MAX_LEN === 66 && cfg.TZ_OFFSET === 0);
  check('通知模式校验生效', cfg.QL_NOTIFY_MODE === 'always');
  const cfgRt = SCRIPT.readConfig({ YUNHU_RECV_TYPE: ' USER ' });
  check('YUNHU_RECV_TYPE 大小写与空格容错', cfgRt.YUNHU_RECV_TYPE === 'user', cfgRt.YUNHU_RECV_TYPE);
  const cfgRtAlias = SCRIPT.readConfig({ EPIC_YUNHU_RECV_TYPE: 'user' });
  check('EPIC_YUNHU_RECV_TYPE 别名生效', cfgRtAlias.YUNHU_RECV_TYPE === 'user', cfgRtAlias.YUNHU_RECV_TYPE);
  const oldLog8 = console.log;
  console.log = function () {};
  let cfgRtBad;
  try {
    cfgRtBad = SCRIPT.readConfig({ YUNHU_RECV_TYPE: 'private' });
  } finally {
    console.log = oldLog8;
  }
  check('非法取值告警后回退 group', cfgRtBad.YUNHU_RECV_TYPE === 'group', cfgRtBad.YUNHU_RECV_TYPE);
  const r8 = await exec({
    stateFile: statePath('env'),
    env: {
      EPIC_YUNHU_BOT_TOKEN: 'alias-token',
      EPIC_COUNTRY: 'US',
      EPIC_LOCALE: 'en-US',
      EPIC_FIRST_RUN_PUSH: 'true',
    },
    fixtures: FIX_PROMO(WEEK_A),
  });
  check('首次运行强制推送生效', r8.pushes.length === 2, '推送数=' + r8.pushes.length);
  check('美区链接与区域参数生效', r8.requestLog.some((x) => /country=US/.test(x.url)) && r8.pushes.length === 2 && /store\.epicgames\.com\/en-US\/p\//.test(r8.pushes[0].content.text));

  // 私聊模式：确认环境变量一路透传到云湖请求体
  const r8b = await exec({
    stateFile: statePath('recvtype'),
    env: {
      YUNHU_RECV_TYPE: 'user',
      YUNHU_RECV_ID: 'uid-8888',
      EPIC_FIRST_RUN_PUSH: 'true',
      PUSH_UPCOMING: 'false',
    },
    fixtures: FIX_PROMO(WEEK_A),
  });
  check('私聊请求体 recvType 为 user', r8b.pushes.length === 1 && r8b.pushes[0].recvType === 'user', r8b.pushes.length ? r8b.pushes[0].recvType : '推送数=' + r8b.pushes.length);
  check('私聊请求体 recvId 取自环境变量', r8b.pushes.length === 1 && r8b.pushes[0].recvId === 'uid-8888');

  // ── 场景 9：HTML + 封面图 ──
  realLog('\n[场景 9] html 消息与封面图');
  const r9 = await exec({
    stateFile: statePath('html'),
    env: { CONTENT_TYPE: 'html', PUSH_COVER: 'true', EPIC_FIRST_RUN_PUSH: 'true', INCLUDE_DESCRIPTION: 'true' },
    fixtures: FIX_PROMO(WEEK_A),
  });
  check('推送 contentType 为 html', r9.pushes.length > 0 && r9.pushes[0].contentType === 'html', r9.pushes.length ? r9.pushes[0].contentType : '');
  check('正文含封面图', r9.pushes.length > 0 && /<img src="https:\/\/cdn\.example\.com\/id-a1\.jpg"/.test(r9.pushes[0].content.text));

  // ── 场景 10：演练模式 ──
  realLog('\n[场景 10] 演练模式：不推送、不改动状态文件');
  const DRY_STATE = statePath('dry');
  fs.writeFileSync(DRY_STATE, JSON.stringify({ region: 'zh-CN/CN', batches: {} }));
  const before10 = fs.readFileSync(DRY_STATE, 'utf8');
  const r10 = await exec({
    stateFile: DRY_STATE,
    env: { EPIC_DRY_RUN: 'true', EPIC_FIRST_RUN_PUSH: 'true' },
    fixtures: FIX_PROMO(WEEK_A),
  });
  check('未产生真实推送', r10.pushes.length === 0, '推送数=' + r10.pushes.length);
  check('返回文案标记演练', /\[演练\]/.test(r10.result), r10.result);
  check('状态文件内容未变', fs.readFileSync(DRY_STATE, 'utf8') === before10);

  // ── 场景 11：状态目录自动创建 ──
  realLog('\n[场景 11] 状态文件所在目录不存在时应自动创建');
  const NESTED_STATE = path.join(TMP_DIR, 'nested', 'deep', 'state.json');
  const r11 = await exec({ stateFile: NESTED_STATE, fixtures: FIX_PROMO(WEEK_A) });
  check('嵌套目录已创建并写入状态', fs.existsSync(NESTED_STATE) && !!readState(NESTED_STATE).batches, r11.result);

  // ── 场景 12：网络失败重试 ──
  realLog('\n[场景 12] Epic 接口异常：重试后失败且不推送');
  const failFixtures = [{ match: 'freeGamesPromotions', body: { data: { Catalog: { searchStore: { elements: [] } } } } }];
  const oldConsole = console.log;
  console.log = function () {};
  let r12;
  try {
    r12 = await SCRIPT.run({
      env: BASE_ENV,
      stateFile: statePath('fail'),
      request: makeRequest([], [], failFixtures),
      notify: async () => {},
      config: { TIMEOUT: 1000 },
    });
  } finally {
    console.log = oldConsole;
  }
  check('返回执行失败', /^执行失败/.test(r12), r12);

  // ── 场景 13：真实接口（可选） ──
  if (process.env.EPIC_RUN_NETWORK_TEST === '1') {
    realLog('\n[场景 13] 真实网络：验证官方接口可用并正确解析');
    const r13 = await exec({ stateFile: statePath('real'), fixtures: [] });
    realLog('  返回：' + r13.result.split('\n').join('\n  '));
    check('接口请求成功且返回促销数据', /首次运行，已记录|无变化|已推送/.test(r13.result), r13.result);
    check('解析出至少一个批次', Object.keys(readState(statePath('real')).batches || {}).length >= 1);
  } else {
    realLog('\n[场景 13] 真实网络测试已跳过（设置 EPIC_RUN_NETWORK_TEST=1 开启）');
  }

  realLog('\n──────────────────────────────');
  realLog('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  realLog('──────────────────────────────\n');

  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (e) {
    /* 清理失败不影响测试结果 */
  }
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试台异常：', e);
  process.exit(1);
});
