# Epic 免费游戏监控 · 青龙面板版

在青龙面板（QingLong）运行：定时查询 Epic 官方免费游戏促销接口，
发现新的「本周免费」或「下周预告」时推送到云湖机器人。

- **零第三方依赖**：只用 Node 内置模块，青龙装完就能跑，不需要 `npm install`
- **配置走环境变量**：token 不写进脚本，改配置不用改代码
- **状态落文件**：批次记录保存在脚本同目录 JSON 文件，重启容器、更新脚本都不会重复推送
- **北京时间显示**：不依赖容器 TZ，容器是 UTC 也不会把 23:00 显示成 15:00
- **7×24 执行**：容器常驻，按 cron 执行，不依赖浏览器
- **批次去重**：以「促销类型 + 开始时间」为批次标识，同一批次只推一次；同批次阵容调整会另发提示

## 实现要点

| 能力 | 实现方式 |
| --- | --- |
| 配置 | 青龙「环境变量」，脚本内 `DEFAULTS` 为默认值 |
| 网络请求 | Node 内置 `https`（可选 HTTP 代理） |
| 状态持久化 | 脚本同目录 `.epic_free_games_state.json`，临时文件 + 原子重命名 |
| 系统通知 | 青龙内置 `sendNotify`（`QL_NOTIFY_MODE` 控制） |
| 定时 | 青龙「定时任务」cron；脚本头 `cron: 30 9,23 * * *` 供 `ql repo` 识别 |
| 日志 | `console.log`，由青龙任务日志收集 |

## 快速开始

### 1. 放脚本

推荐只放这一个文件，避免青龙把测试台也扫成任务。

方式 A：青龙容器内执行（需能访问 GitHub raw）

```bash
ql raw https://raw.githubusercontent.com/yimu56/epic-free-games-notify-QingLong/main/epic-free-games-notify.js
```

方式 B：面板操作

「脚本管理」→ 新建文件 `epic-free-games-notify.js` → 粘贴本仓库 `epic-free-games-notify.js` 的内容 → 保存。

文件默认落在 `/ql/data/scripts/`，状态文件也写在这个目录（青龙已持久化该目录）。

> 如果用 `ql repo` 订阅整个仓库，青龙会扫描仓库内所有 `.js`，
> 建议把 `test` 目录加入黑名单，或直接用上面的 `ql raw` 只拉主脚本。

### 2. 配环境变量

青龙面板 →「环境变量」→ 新建变量，至少配前两项：

| 变量名 | 值 |
| --- | --- |
| `YUNHU_TOKEN` | 云湖控制台「机器人发送消息链接」里 `token=` 后面的内容 |
| `YUNHU_RECV_ID` | 群号（`YUNHU_RECV_TYPE=group`）或用户 ID（`user`） |
| `YUNHU_RECV_TYPE` | 可选，`group`（默认，群聊）或 `user`（私聊） |

云湖链接形如 `https://chat-go.jwzhd.com/open-apis/v1/bot/send?token=xxxxxxxx`。

脚本里的 `DEFAULTS` 只是默认值，**包括 `YUNHU_RECV_TYPE` 在内的所有配置项都从青龙环境变量读取**，
改配置不需要动脚本。例如发私聊时新建 `YUNHU_RECV_TYPE` = `user`，`YUNHU_RECV_ID` 填用户 ID 即可。

### 3. 建定时任务

青龙面板 →「定时任务」→ 新建：

| 字段 | 值 |
| --- | --- |
| 名称 | Epic 免费游戏监控 |
| 命令 | `task epic-free-games-notify.js` |
| 定时 | `30 9,23 * * *` |

脚本头部写了 `cron: 30 9,23 * * *`，用 `ql repo` 订阅时青龙也会自动识别。

**时区**：青龙的 cron 按容器时区执行。想按北京时间跑，先在青龙「系统设置」或容器环境变量里设 `TZ=Asia/Shanghai`；
若容器固定为 UTC，上式改成 `30 1,15 * * *`（对应北京时间 09:30 / 23:30）。
消息里的时间显示由 `EPIC_TZ_OFFSET` 独立控制，不受容器 TZ 影响。

Epic 换周时间点是北京时间周四 23:00，23:30 那一次就能抓到新批次；
09:30 用来兜底接口临时故障和阵容调整。想更激进可以 `0 */3 * * *`，去重逻辑保证不会重复推送。

### 4. 先演练再启用

```bash
# 青龙容器内执行（走 task 才能加载面板里配的环境变量）
cd /ql/data/scripts && EPIC_DRY_RUN=true task epic-free-games-notify.js
```

也可以在青龙面板临时加一个 `EPIC_DRY_RUN=true` 环境变量，在「定时任务」里点运行，验证完删掉该变量。

演练模式只打印将要推送的消息内容，不发送到云湖，也不改动状态文件。
确认消息正常后，去掉该变量正式运行。

首次运行默认**只记录基线、不推送**（`FIRST_RUN_PUSH=false`），避免刚部署就收到历史消息。
想首次就收一条，把 `FIRST_RUN_PUSH` 设为 `true`，并把 `EPIC_DRY_RUN` 去掉。

## 环境变量

除 `YUNHU_TOKEN`、`YUNHU_RECV_ID` 外全部可选。布尔值接受 `true/false/1/0/yes/no/on/off`。

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `YUNHU_TOKEN` | 空 | 云湖机器人 token，必填；别名 `EPIC_YUNHU_TOKEN` |
| `YUNHU_RECV_ID` | 空 | 接收者 ID，必填；别名 `EPIC_YUNHU_RECV_ID` |
| `YUNHU_RECV_TYPE` | `group` | `group` 群聊 / `user` 私聊；大小写不敏感，别名 `EPIC_YUNHU_RECV_TYPE`，非法值会告警并回退 `group` |
| `EPIC_LOCALE` | `zh-CN` | 接口语言，同时决定商店链接前缀 |
| `EPIC_COUNTRY` | `CN` | 接口地区，决定可见商品与价格货币，可取 `US` 等 |
| `PUSH_CURRENT` | `true` | 是否推送「本周免费」 |
| `PUSH_UPCOMING` | `true` | 是否推送「下周预告」 |
| `ONLY_BASE_GAME` | `true` | 仅游戏本体，忽略 DLC、附加内容与礼包 |
| `INCLUDE_DESCRIPTION` | `true` | 是否附带商品简介 |
| `DESC_MAX_LEN` | `200` | 简介截断长度 |
| `CONTENT_TYPE` | `markdown` | `markdown` 自动适配深浅色；`html` 支持封面图 |
| `PUSH_COVER` | `false` | 输出封面图外链，仅 `CONTENT_TYPE=html` 时生效 |
| `FIRST_RUN_PUSH` | `false` | 首次运行（无状态文件）是否推送当前批次 |
| `KEEP_BATCHES` | `12` | 状态文件保留的批次数量上限 |
| `EPIC_TZ_OFFSET` | `8` | 消息时间用的时区偏移（小时），默认北京时间 |
| `EPIC_TIMEOUT` | `20000` | 单次请求超时（毫秒） |
| `EPIC_PROXY` | 空 | 访问 Epic 接口的 HTTP 代理，形如 `http://127.0.0.1:7890` |
| `QL_NOTIFY_MODE` | `error` | `off` 关闭 / `error` 仅失败 / `always` 推送与失败都发青龙系统通知 |
| `EPIC_DRY_RUN` | `false` | 演练模式，不发送、不写状态 |
| `EPIC_STATE_FILE` | 脚本同目录 | 自定义状态文件路径 |

配置读取优先级：青龙环境变量 > 脚本内 `DEFAULTS`。因此本地直接 `node epic-free-games-notify.js` 也能跑，
只要把 `YUNHU_TOKEN`、`YUNHU_RECV_ID` 写进 shell 环境变量即可。

## 状态文件

默认路径与脚本同目录：`.epic_free_games_state.json`：

```json
{
  "region": "zh-CN/CN",
  "batches": {
    "current|2026-10-08T15:00:00.000Z": {
      "ids": ["..."],
      "startDate": "...",
      "titles": ["..."],
      "pushedAt": 1760000000000,
      "pushed": true
    }
  },
  "updatedAt": 1760000000000
}
```

- 采用「先写临时文件再原子重命名」，青龙任务并发或中途被杀不会写坏文件
- 只有**推送成功后**才记录批次；网络异常、云湖返回失败时下次执行会自动重试
- 修改 `EPIC_LOCALE` / `EPIC_COUNTRY` 后旧批次自动作废，重新建立基线（不会重复推送）
- 想强制重推一次：删掉状态文件，并把 `FIRST_RUN_PUSH` 设为 `true`
- 文件已加入仓库 `.gitignore`，不会把 token 或状态提交上去

## 青龙系统通知

脚本会依次尝试加载 `./sendNotify.js`、`../sendNotify.js`、`/ql/data/scripts/sendNotify.js` 等路径，
找到就调用 `sendNotify(title, text)`；找不到则静默跳过，不影响云湖推送。

默认 `QL_NOTIFY_MODE=error`，只在执行失败（接口异常、云湖报错、配置缺失）时发一条青龙通知。
云湖本身已是主推送渠道，不需要重复通知时保持 `off` 即可。

## 代理

云湖接口在国内，始终直连；只有 Epic 接口会走 `EPIC_PROXY`。

```bash
EPIC_PROXY=http://127.0.0.1:7890
```

仅支持 `http://` 形式的代理（含 `user:pass@host:port` 鉴权），通过 HTTP CONNECT 隧道转发 HTTPS。
多数容器直连 Epic CDN 就没问题，不需要配。

## 测试

```bash
# 在本仓库根目录执行
node test/run-test.js

# 附带真实 Epic 接口连通性检查
EPIC_RUN_NETWORK_TEST=1 node test/run-test.js
```

测试台通过 `run({ env, stateFile, request, notify })` 注入依赖，不访问真实群聊，
状态写在系统临时目录并自动清理。默认覆盖 51 项检查（开启真实网络为 53 项）：首次运行、批次去重、
换周双批次推送、阵容调整、地区切换、配置缺失、环境变量别名与解析、
`YUNHU_RECV_TYPE` 大小写容错与私聊请求体透传、HTML 封面图、演练模式、
状态目录自动创建、接口失败重试、真实接口解析。

## 项目结构

```
epic-free-games-notify-QingLong/
├── epic-free-games-notify.js   # 青龙面板脚本主体
├── test/
│   └── run-test.js             # 离线测试台
├── README.md
├── LICENSE
├── .gitignore
└── .gitattributes
```

## 已知限制

- **商店网页无法直接抓取**：Epic 商店页面受 Cloudflare 保护，直接请求返回 403，统一走官方促销接口。
- **接口地区决定商品范围**：国区与美区阵容、货币不同，默认 `CN`。
- **同一款游戏会推送两次**：先作为「下周预告」，换周后作为「本周免费」，属设计预期。
- **云湖图片不支持外链**：图片消息只能用云湖上传接口返回的 `imageKey`，因此默认只推文字；
  封面图仅在 `CONTENT_TYPE=html` 时以外链形式展示，部分客户端可能不加载。
- **云湖成功码为 1**：正常返回 `{"code": 1}`，脚本按此判断成功。

## 免责声明

本项目仅供学习与研究使用，与 Epic Games、云湖官方无任何关联。

使用过程需遵守目标站点的服务条款与相关法律法规，因使用本项目产生的一切后果由使用者自行承担。
相关接口可能随时变更，脚本不保证长期可用。

## 许可证

[MIT](./LICENSE)
