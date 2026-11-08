#!/usr/bin/env node
/**
 * Epic 免费游戏监控 · 云湖机器人推送（青龙面板版）
 *
 * 数据来源：Epic 官方免费游戏促销接口（无需登录、无需 Cookie）
 *   https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions
 *
 * 运行方式：
 *   - 网络请求   -> Node 内置 https（零第三方依赖，可选 HTTP 代理）
 *   - 状态持久化 -> 脚本同目录下的 JSON 状态文件（可用 EPIC_STATE_FILE 覆盖）
 *   - 系统通知   -> 青龙内置 sendNotify（QL_NOTIFY_MODE 控制）
 *   - 定时任务   -> 青龙面板 cron，命令：task epic-free-games-notify.js
 *   - 配置       -> 青龙「环境变量」，也支持脚本内默认值，本地可直接 node 运行
 *
 * 青龙 repo 自动识别的定时规则（面板里也可以手动改）：
 * cron: 30 9,23 * * *
 *
 * 仓库：https://github.com/yimu56/epic-free-games-notify-QingLong
 * 协议：MIT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const TAG = '[Epic免费游戏监控]';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FREE_GAMES_PAGE = 'https://store.epicgames.com/zh-CN/free-games';
const EPIC_API = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';
const YUNHU_API = 'https://chat-go.jwzhd.com/open-apis/v1/bot/send';
const DEFAULT_STATE_FILE = path.join(__dirname, '.epic_free_games_state.json');

/* ==================== 默认配置（全部可用青龙环境变量覆盖） ==================== */

const DEFAULTS = {
  // 商店区域
  LOCALE: 'zh-CN',
  COUNTRY: 'CN',

  // 云湖机器人
  YUNHU_TOKEN: '',
  YUNHU_RECV_ID: '',
  YUNHU_RECV_TYPE: 'group',

  // 推送范围
  PUSH_CURRENT: true,
  PUSH_UPCOMING: true,
  ONLY_BASE_GAME: true,
  INCLUDE_DESCRIPTION: true,
  DESC_MAX_LEN: 200,

  // 消息行为
  CONTENT_TYPE: 'markdown',
  PUSH_COVER: false,
  FIRST_RUN_PUSH: false,
  KEEP_BATCHES: 12,

  // 运行环境
  // 显示时间用的时区偏移（小时），默认北京时间 UTC+8，不依赖容器 TZ
  TZ_OFFSET: 8,
  // 单次请求超时（毫秒）
  TIMEOUT: 20000,
  // 访问 Epic 接口用的 HTTP 代理，形如 http://127.0.0.1:7890；云湖接口始终直连
  PROXY: '',
  // 青龙系统通知：off 关闭 / error 仅失败时 / always 推送与失败都通知
  QL_NOTIFY_MODE: 'error',
  // 演练模式：只打印将要推送的内容，不真正发送，也不改动状态文件
  DRY_RUN: false,
  // 状态文件路径，默认脚本同目录
  STATE_FILE: DEFAULT_STATE_FILE,
};

// 环境变量名，靠前的优先；同一项可写多个别名
const ENV_MAP = {
  LOCALE: ['EPIC_LOCALE'],
  COUNTRY: ['EPIC_COUNTRY'],
  YUNHU_TOKEN: ['YUNHU_TOKEN', 'EPIC_YUNHU_TOKEN'],
  YUNHU_RECV_ID: ['YUNHU_RECV_ID', 'EPIC_YUNHU_RECV_ID'],
  YUNHU_RECV_TYPE: ['YUNHU_RECV_TYPE', 'EPIC_YUNHU_RECV_TYPE'],
  PUSH_CURRENT: ['PUSH_CURRENT', 'EPIC_PUSH_CURRENT'],
  PUSH_UPCOMING: ['PUSH_UPCOMING', 'EPIC_PUSH_UPCOMING'],
  ONLY_BASE_GAME: ['ONLY_BASE_GAME', 'EPIC_ONLY_BASE_GAME'],
  INCLUDE_DESCRIPTION: ['INCLUDE_DESCRIPTION', 'EPIC_INCLUDE_DESCRIPTION'],
  DESC_MAX_LEN: ['DESC_MAX_LEN', 'EPIC_DESC_MAX_LEN'],
  CONTENT_TYPE: ['CONTENT_TYPE', 'EPIC_CONTENT_TYPE'],
  PUSH_COVER: ['PUSH_COVER', 'EPIC_PUSH_COVER'],
  FIRST_RUN_PUSH: ['FIRST_RUN_PUSH', 'EPIC_FIRST_RUN_PUSH'],
  KEEP_BATCHES: ['KEEP_BATCHES', 'EPIC_KEEP_BATCHES'],
  TZ_OFFSET: ['EPIC_TZ_OFFSET'],
  TIMEOUT: ['EPIC_TIMEOUT'],
  PROXY: ['EPIC_PROXY'],
  QL_NOTIFY_MODE: ['QL_NOTIFY_MODE'],
  DRY_RUN: ['EPIC_DRY_RUN'],
  STATE_FILE: ['EPIC_STATE_FILE'],
};

/* ==================== 基础工具 ==================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(text) {
  console.log(TAG + ' ' + text);
}

function parseBool(value, def) {
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].indexOf(v) >= 0) return true;
  if (['0', 'false', 'no', 'off', 'n'].indexOf(v) >= 0) return false;
  return def;
}

function pickEnv(env, names) {
  for (const name of names) {
    const v = env[name];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

function readConfig(env) {
  const source = env || process.env;
  const cfg = Object.assign({}, DEFAULTS);
  for (const key of Object.keys(ENV_MAP)) {
    const raw = pickEnv(source, ENV_MAP[key]);
    if (raw === undefined) continue;
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') cfg[key] = parseBool(raw, def);
    else if (typeof def === 'number') {
      const n = Number(raw);
      cfg[key] = Number.isFinite(n) ? n : def;
    } else cfg[key] = raw;
  }
  if (!cfg.STATE_FILE) cfg.STATE_FILE = DEFAULT_STATE_FILE;
  cfg.CONTENT_TYPE = String(cfg.CONTENT_TYPE).trim().toLowerCase() === 'html' ? 'html' : 'markdown';
  // 环境变量取值大小写不敏感；非法值明确告警后回退默认，避免静默把私聊发到群里
  const recvType = String(cfg.YUNHU_RECV_TYPE).trim().toLowerCase();
  if (recvType === 'user' || recvType === 'group') {
    cfg.YUNHU_RECV_TYPE = recvType;
  } else {
    log('YUNHU_RECV_TYPE 取值无效（' + cfg.YUNHU_RECV_TYPE + '），已回退为 ' + DEFAULTS.YUNHU_RECV_TYPE + '；仅支持 group / user');
    cfg.YUNHU_RECV_TYPE = DEFAULTS.YUNHU_RECV_TYPE;
  }
  cfg.QL_NOTIFY_MODE = String(cfg.QL_NOTIFY_MODE).trim().toLowerCase();
  if (['off', 'error', 'always'].indexOf(cfg.QL_NOTIFY_MODE) < 0) {
    cfg.QL_NOTIFY_MODE = DEFAULTS.QL_NOTIFY_MODE;
  }
  return cfg;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 接口返回 UTC 时间；按固定偏移换算，避免青龙容器 TZ 为 UTC 导致显示错 8 小时
function fmtDateTime(iso, tzOffset) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '');
  const t = new Date(d.getTime() + Number(tzOffset || 0) * 3600 * 1000);
  return (
    pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate()) +
    ' ' + pad2(t.getUTCHours()) + ':' + pad2(t.getUTCMinutes())
  );
}

function truncate(text, max) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max) + '……（简介过长，已截断）';
}

function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ==================== 网络请求（零依赖，可选 HTTP 代理） ==================== */

/**
 * 返回 { status, responseText }。
 * cfg.PROXY 仅用于 Epic 接口（opt.useProxy !== false），云湖为国内接口默认直连。
 */
function httpRequest(urlString, opt, cfg) {
  opt = opt || {};
  cfg = cfg || readConfig({});
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlString);
    } catch (e) {
      reject(new Error('URL 无效：' + urlString));
      return;
    }

    const headers = Object.assign(
      { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity' },
      opt.headers || {}
    );
    const body = opt.data === undefined || opt.data === null ? null : Buffer.from(String(opt.data), 'utf8');
    if (body) headers['Content-Length'] = body.length;

    const common = {
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opt.method || 'GET',
      headers,
    };

    const onResponse = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, responseText: Buffer.concat(chunks).toString('utf8') })
      );
    };

    const attach = (req) => {
      req.on('error', reject);
      req.setTimeout(cfg.TIMEOUT, () => req.destroy(new Error('请求超时')));
      if (body) req.write(body);
      req.end();
    };

    const useProxy = !!cfg.PROXY && opt.useProxy !== false;
    if (!useProxy) {
      attach(https.request(Object.assign({ agent: false }, common), onResponse));
      return;
    }

    let p;
    try {
      p = new URL(cfg.PROXY);
    } catch (e) {
      reject(new Error('EPIC_PROXY 格式错误，应形如 http://127.0.0.1:7890'));
      return;
    }
    if (p.protocol !== 'http:') {
      reject(new Error('EPIC_PROXY 仅支持 http:// 代理'));
      return;
    }

    const proxyHeaders = {};
    if (p.username) {
      const user = decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password || '');
      proxyHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(user).toString('base64');
    }
    const tunnel = http.request({
      host: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: common.host + ':' + common.port,
      headers: proxyHeaders,
    });
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理 CONNECT 失败 HTTP ' + res.statusCode));
        return;
      }
      attach(
        https.request(
          Object.assign({}, common, {
            agent: false,
            createConnection: () => tls.connect({ socket, servername: common.host }),
          }),
          onResponse
        )
      );
    });
    tunnel.on('error', reject);
    tunnel.setTimeout(cfg.TIMEOUT, () => tunnel.destroy(new Error('代理连接超时')));
    tunnel.end();
  });
}

async function fetchPromotions(cfg, request) {
  const url =
    EPIC_API +
    '?locale=' + encodeURIComponent(cfg.LOCALE) +
    '&country=' + encodeURIComponent(cfg.COUNTRY) +
    '&allowCountries=' + encodeURIComponent(cfg.COUNTRY);

  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(1500 * i);
    try {
      const res = await request(url, { headers: { 'User-Agent': UA } });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      let json;
      try {
        json = JSON.parse(res.responseText);
      } catch (e) {
        throw new Error('响应内容不是合法 JSON');
      }
      const elements =
        json && json.data && json.data.Catalog && json.data.Catalog.searchStore &&
        json.data.Catalog.searchStore.elements;
      if (!elements || !elements.length) throw new Error('接口未返回任何促销数据');
      return elements;
    } catch (e) {
      lastErr = e;
      log('获取促销数据第 ' + (i + 1) + ' 次失败：' + e.message);
    }
  }
  throw lastErr || new Error('获取促销数据失败');
}

async function pushYunhu(cfg, text, contentType, request) {
  const url = YUNHU_API + '?token=' + encodeURIComponent(cfg.YUNHU_TOKEN);
  const payload = JSON.stringify({
    recvId: String(cfg.YUNHU_RECV_ID),
    recvType: cfg.YUNHU_RECV_TYPE,
    contentType,
    content: { text },
  });

  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    data: payload,
    useProxy: false,
  });
  if (res.status !== 200) throw new Error('云湖接口 HTTP ' + res.status);

  let json;
  try {
    json = JSON.parse(res.responseText);
  } catch (e) {
    throw new Error('云湖接口返回内容不是合法 JSON：' + String(res.responseText).slice(0, 200));
  }
  // 云湖的成功码为 1
  if (json.code !== 1) {
    throw new Error('云湖推送失败 code=' + json.code + (json.msg ? ' ' + json.msg : ''));
  }
  return json;
}

/* ==================== 状态持久化 ==================== */

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (e) {
    if (e.code !== 'ENOENT') log('状态文件读取失败，按首次运行处理：' + e.message);
    return {};
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function pruneBatches(batches, keep) {
  const keys = Object.keys(batches);
  if (keys.length <= keep) return batches;
  keys.sort((a, b) => (batches[a].pushedAt || 0) - (batches[b].pushedAt || 0));
  const kept = {};
  for (const k of keys.slice(-keep)) kept[k] = batches[k];
  return kept;
}

/* ==================== 青龙通知（可选） ==================== */

function loadQlNotify() {
  const candidates = [
    path.join(__dirname, 'sendNotify.js'),
    path.join(__dirname, '..', 'sendNotify.js'),
    path.join(process.cwd(), 'sendNotify.js'),
    '/ql/data/scripts/sendNotify.js',
    '/ql/scripts/sendNotify.js',
  ];
  for (const p of candidates) {
    try {
      const mod = require(p);
      if (mod && typeof mod.sendNotify === 'function') return mod.sendNotify;
    } catch (e) {
      /* 该路径没有 sendNotify，继续找 */
    }
  }
  return null;
}

async function qlNotify(cfg, title, text, isError) {
  if (cfg.QL_NOTIFY_MODE === 'off') return;
  if (cfg.QL_NOTIFY_MODE === 'error' && !isError) return;
  const fn = loadQlNotify();
  if (!fn) return;
  try {
    await fn(title, text);
  } catch (e) {
    log('青龙通知发送失败：' + e.message);
  }
}

/* ==================== 数据解析与消息构造 ==================== */

// 从促销分组中取出「折扣 100%（免费）」的那一条
function pickFreeOffer(groups) {
  for (const group of groups || []) {
    for (const offer of (group && group.promotionalOffers) || []) {
      const pct = offer && offer.discountSetting && offer.discountSetting.discountPercentage;
      if (pct === 0) return offer;
    }
  }
  return null;
}

function buildStoreUrl(el, cfg) {
  let slug = el.productSlug;
  if (!slug && el.catalogNs && el.catalogNs.mappings && el.catalogNs.mappings.length) {
    slug = el.catalogNs.mappings[0].pageSlug;
  }
  if (!slug) slug = el.urlSlug;
  if (!slug) return FREE_GAMES_PAGE;
  return 'https://store.epicgames.com/' + cfg.LOCALE + '/p/' + slug;
}

function pickCover(keyImages) {
  const images = keyImages || [];
  const prefer = ['OfferImageWide', 'Thumbnail', 'OfferImageTall'];
  for (const type of prefer) {
    const hit = images.find((img) => img && img.type === type && img.url);
    if (hit) return hit.url;
  }
  return (images[0] && images[0].url) || '';
}

function buildItem(el, offer, kind, cfg) {
  const price = (el.price && el.price.totalPrice) || {};
  const fmt = price.fmtPrice || {};
  const desc = String(el.description || '').trim();

  return {
    kind,
    id: el.id,
    title: el.title || '未知商品',
    description: desc && desc !== el.title ? desc : '',
    seller: (el.seller && el.seller.name) || '',
    offerType: el.offerType || '',
    priceText: fmt.originalPrice || (price.originalPrice ? String(price.originalPrice / 100) : ''),
    currency: price.currencyCode || '',
    startDate: offer.startDate,
    endDate: offer.endDate,
    url: buildStoreUrl(el, cfg),
    cover: pickCover(el.keyImages),
  };
}

function parseBatches(elements, cfg) {
  const items = [];
  for (const el of elements || []) {
    if (cfg.ONLY_BASE_GAME && el.offerType !== 'BASE_GAME') continue;
    const promo = el.promotions || {};

    const current = pickFreeOffer(promo.promotionalOffers);
    if (current) items.push(buildItem(el, current, 'current', cfg));

    const upcoming = pickFreeOffer(promo.upcomingPromotionalOffers);
    if (upcoming) items.push(buildItem(el, upcoming, 'upcoming', cfg));
  }
  return items;
}

// 批次标识：类型 + 开始时间，同批次内商品变化通过 ids 判断
function toBatches(items) {
  const map = {};
  for (const item of items) {
    const key = item.kind + '|' + item.startDate;
    if (!map[key]) {
      map[key] = {
        kind: item.kind,
        startDate: item.startDate,
        endDate: item.endDate,
        ids: [],
        items: [],
      };
    }
    map[key].ids.push(item.id);
    map[key].items.push(item);
  }
  const list = Object.keys(map).map((k) => {
    map[k].ids.sort();
    map[k].key = k;
    return map[k];
  });
  list.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return list;
}

function batchTitle(batch, cfg) {
  const range = fmtDateTime(batch.startDate, cfg.TZ_OFFSET) + ' ~ ' + fmtDateTime(batch.endDate, cfg.TZ_OFFSET);
  return batch.kind === 'upcoming'
    ? 'Epic 下周免费游戏预告（' + range + '）'
    : 'Epic 本周免费游戏（' + range + '）';
}

function buildMarkdown(batch, cfg, isUpdate) {
  const lines = [];
  lines.push('**' + batchTitle(batch, cfg) + '**');
  if (isUpdate) lines.push('（免费阵容有调整）');
  lines.push('');

  for (const item of batch.items) {
    lines.push('**《' + item.title + '》**' + (item.priceText ? '　原价 ' + item.priceText : ''));
    lines.push(item.url);
    if (cfg.INCLUDE_DESCRIPTION && item.description) {
      lines.push(truncate(item.description, cfg.DESC_MAX_LEN));
    }
    lines.push('');
  }

  lines.push('领取入口：' + FREE_GAMES_PAGE);
  return lines.join('\n').trim();
}

function buildHtml(batch, cfg, isUpdate) {
  const parts = [];
  parts.push('<p><b>' + esc(batchTitle(batch, cfg)) + '</b></p>');
  if (isUpdate) parts.push('<p>（免费阵容有调整）</p>');

  for (const item of batch.items) {
    parts.push('<p><b>《' + esc(item.title) + '》</b>' + (item.priceText ? '　原价 ' + esc(item.priceText) : '') + '</p>');
    if (cfg.PUSH_COVER && item.cover) {
      parts.push('<p><img src="' + esc(item.cover) + '" width="360"></p>');
    }
    parts.push('<p><a href="' + esc(item.url) + '">' + esc(item.url) + '</a></p>');
    if (cfg.INCLUDE_DESCRIPTION && item.description) {
      parts.push('<p>' + esc(truncate(item.description, cfg.DESC_MAX_LEN)) + '</p>');
    }
  }

  parts.push('<p>领取入口：<a href="' + FREE_GAMES_PAGE + '">' + FREE_GAMES_PAGE + '</a></p>');
  return parts.join('');
}

/* ==================== 主流程 ==================== */

/**
 * 执行一次检查。
 * options 供测试注入：{ env, config, stateFile, request, notify }
 *   request(url, opt) -> Promise<{ status, responseText }>
 */
async function run(options) {
  const o = options || {};
  const cfg = Object.assign(readConfig(o.env || process.env), o.config || {});
  const stateFile = o.stateFile || cfg.STATE_FILE;
  const request = o.request || ((url, opt) => httpRequest(url, opt, cfg));
  const notify = o.notify || ((title, text, isError) => qlNotify(cfg, title, text, isError));

  try {
    const missing = [];
    if (!cfg.YUNHU_TOKEN) missing.push('YUNHU_TOKEN');
    if (!cfg.YUNHU_RECV_ID) missing.push('YUNHU_RECV_ID');
    if (missing.length) {
      const msg = '环境变量未填写 ' + missing.join('、') + '，本次未执行';
      log(msg);
      await notify('Epic 免费游戏监控未执行', msg, true);
      return msg;
    }

    const elements = await fetchPromotions(cfg, request);
    const items = parseBatches(elements, cfg);

    const region = cfg.LOCALE + '/' + cfg.COUNTRY;
    const state = loadState(stateFile);
    // 切换商店区域后，旧的批次记录不再适用，重新开始记录
    const batches = state.region && state.region !== region ? {} : state.batches || {};
    const isFirstRun = Object.keys(batches).length === 0;

    const summary = [];
    let pushCount = 0;
    let stateChanged = false;

    for (const batch of toBatches(items)) {
      const label = batch.kind === 'upcoming' ? '下周预告' : '本周免费';
      if (batch.kind === 'current' && !cfg.PUSH_CURRENT) continue;
      if (batch.kind === 'upcoming' && !cfg.PUSH_UPCOMING) continue;

      const prev = batches[batch.key];
      const sameIds = prev && prev.ids && prev.ids.join(',') === batch.ids.join(',');
      const titles = batch.items.map((i) => i.title).join('、');

      if (sameIds) {
        summary.push(label + '（' + titles + '）无变化');
        continue;
      }

      if (isFirstRun && !cfg.FIRST_RUN_PUSH) {
        batches[batch.key] = {
          ids: batch.ids,
          startDate: batch.startDate,
          titles: batch.items.map((i) => i.title),
          pushedAt: Date.now(),
          pushed: false,
        };
        stateChanged = true;
        summary.push(label + '（' + titles + '）首次运行，已记录');
        continue;
      }

      const isUpdate = !!(prev && prev.pushed);
      const contentType = cfg.CONTENT_TYPE === 'html' ? 'html' : 'markdown';
      const text = contentType === 'html'
        ? buildHtml(batch, cfg, isUpdate)
        : buildMarkdown(batch, cfg, isUpdate);

      if (cfg.DRY_RUN) {
        log(label + ' [演练] 将要推送的内容：\n' + text);
        summary.push(label + ' [演练] 未发送，状态文件保持不变');
        pushCount++;
        continue;
      }

      if (pushCount > 0) await sleep(800);
      await pushYunhu(cfg, text, contentType, request);
      pushCount++;
      log(label + ' 已推送：' + titles);

      batches[batch.key] = {
        ids: batch.ids,
        startDate: batch.startDate,
        titles: batch.items.map((i) => i.title),
        pushedAt: Date.now(),
        pushed: true,
      };
      stateChanged = true;
      summary.push(label + ' 已推送 ' + batch.items.length + ' 款：' + titles);
    }

    if (!summary.length) {
      const msg = '接口未返回任何免费游戏促销，本次未推送';
      log(msg);
      return msg;
    }

    if (stateChanged && !cfg.DRY_RUN) {
      saveState(stateFile, {
        region,
        batches: pruneBatches(batches, cfg.KEEP_BATCHES),
        updatedAt: Date.now(),
      });
    }

    const text = summary.join('\n');
    log(text);
    if (pushCount > 0 && !cfg.DRY_RUN) {
      await notify('Epic 免费游戏监控', summary.filter((s) => s.indexOf('已推送') >= 0).join('\n').slice(0, 500), false);
    }
    return text;
  } catch (err) {
    const msg = '执行失败：' + ((err && err.message) || String(err));
    log(msg);
    await notify('Epic 免费游戏监控执行失败', msg, true);
    return msg;
  }
}

module.exports = {
  run,
  readConfig,
  httpRequest,
  loadState,
  saveState,
  parseBatches,
  toBatches,
  buildMarkdown,
  fmtDateTime,
  DEFAULTS,
};

if (require.main === module) {
  run().then((result) => {
    // 让青龙把「配置缺失 / 执行异常」显示为失败任务
    if (/^(执行失败|环境变量未填写)/.test(result)) process.exitCode = 1;
  }).catch((err) => {
    console.error(TAG + ' 未捕获异常：' + ((err && err.stack) || String(err)));
    process.exitCode = 1;
  });
}
