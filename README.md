# 基金持仓价格趋势监测客户端

检测基金持仓价格(估值)变动趋势的**桌面客户端**(Electron 原生窗口,也支持纯命令行 Web 模式)。**每分钟自动同步基金预测(估值)价格涨跌**,显示基金各种概要说明,支持多只基金并行监测、搜索与关注,并从多个信息源负载均衡采集,内置反封禁限流,避免被当作爬虫封 IP。

**每个交易日 14:50(北京时间,可配置)自动推送关注基金的预估当日涨跌** —— 收盘前最后一次估值同步后的汇总报告,窗口内弹层 + 系统原生通知。

![颜色约定](https://img.shields.io/badge/红涨-绿跌-critical) 遵循A股习惯:**红涨绿跌**。

## 功能

- ⏱ **每分钟同步**:后台定时(60s ± 抖动)同步一次估值涨跌,支持手动"立即同步"
- 📊 **收盘预估推送**:交易日 14:50(北京时间,`closingReport.time` 可改)自动推送全部关注基金的预估当日涨跌汇总(涨/跌家数、平均预估、日内趋势与高低点);也有 "📊 收盘预估" 按钮随时手动触发
- 📈 **趋势检测**:每只基金保留分钟级采样环(约一个交易日),计算日内趋势(上行/下行/持平)、高低点、最小二乘斜率,迷你走势图直观展示
- 📋 **概要说明**:基金公司/经理(星级/年限/规模)/托管行/成立日/风险等级/费率/起购/最新净值/阶段收益(1-3-6-12月)/持有人结构/资产配置/重仓股/历史净值表
- 🔍 **搜索与关注**:按代码/名称/拼音联想搜索,一键关注、取关、改名;列表自动持久化,重启不丢
- 🌈 **红涨绿跌**:所有涨跌数字与图表一律红涨绿跌
- 🔔 **阈值提醒**:估值涨跌跨越 ±0.5/1/2% 等阈值时弹出提醒(30 分钟去重),事件流可查
- 🛡 **反封禁设计**(详见下文)
- ⚡ **实时推送**:SSE 推送估值更新与提醒,无需手动刷新

## 快速开始

### 桌面客户端(推荐)

```bash
npm run build:desktop     # 产出 release/FundTrendMonitor-Portable.exe
```

双击 `FundTrendMonitor-Portable.exe` 即可:原生窗口 + 任务栏图标,内嵌监测服务,提醒走 **Windows 系统通知**(最小化也能收到)。数据/配置存于 `%APPDATA%/fund-trend-monitor/`。

### 单文件 exe(SEA,无 Electron)

```bash
npm run build:exe         # 产出 dist/FundTrendMonitor.exe (~88MB)
```

### 命令行 Web 模式

```bash
node server.js            # 默认 http://127.0.0.1:8787
node server.js --port 9000 --host 0.0.0.0
```

> CLI 模式零第三方依赖,Node ≥ 18.17 即可。搜索基金代码(如 `161725`)点击"+关注"。

## 数据源与负载均衡

| 用途 | 数据源 | 说明 |
|---|---|---|
| 实时估值(主) | 新浪 `hq.sinajs.cn` (`fu_`) | 批量接口,一次请求全部基金,GBK |
| 净值兜底(备) | 腾讯 `qt.gtimg.cn` (`jj`) | 新浪故障时自动切换(注意:返回确认净值,非实时估值) |
| 概要信息 | 蛋卷 `danjuanfunds.com` + 东财 `pingzhongdata` | 双源字段合并,互为兜底 |
| 历史净值 | 东财 `api.fund.eastmoney.com` f10 | TTL 缓存 1h |
| 搜索 | 东财 `fundsuggest.eastmoney.com` | 联想接口 |

- **估值源轮询**:新浪/腾讯按轮询顺序使用,均摊请求;单源失败自动退避(指数 30s→15min)并立即切换下一源。
- **概要双源合并**:蛋卷优先,失败降级东财;结果缓存 6 小时(概要一天内几乎不变)。

## 反封禁(防爬虫封 IP)策略

1. **每 host 独立限流**:令牌桶(默认 20 req/min)+ 请求间最小间隔(默认 800ms)+ 同 host 请求串行化,防并发突发。
2. **指数退避**:某 host 连续失败 → 30s、1m、2m … 最长 15min 暂停请求,避免撞封禁线。
3. **请求合并**:估值批量拉取,40 只基金也只发 1 个请求/分钟;概要与历史净值走 TTL 缓存,不重复抓取。
4. **UA 轮换**:Chrome/Edge/Safari/iPhone 多 UA 轮换,并携带与真实浏览器一致的 `Referer`。
5. **抖动**:同步时刻 ±8s 随机抖动,避免整点规律请求。
6. **健康度可视**:首页底部实时显示各 host 成功率/退避状态(`/api/sources`)。

以上阈值均可在 `config.json` 的 `rateLimit` 调整。

## 配置(config.json)

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "sync": { "intervalMs": 60000, "jitterMs": 8000, "maxFundsPerCycle": 40 },
  "rateLimit": {
    "minIntervalMs": 800,      // 同 host 请求最小间隔
    "maxPerMinute": 20,        // 每 host 令牌桶速率
    "backoffBaseMs": 30000,    // 失败退避基数
    "backoffMaxMs": 900000     // 退避上限 15 分钟
  },
  "summaryCacheMs": 21600000,  // 概要缓存 6h
  "alertThresholds": [0.5, 1.0, 2.0, -0.5, -1.0, -2.0],
  "closingReport": {
    "enabled": true,
    "time": "14:50",           // 北京时间,尾盘推送时刻
    "holidays": []             // 额外节假日 'YYYY-MM-DD'(周末自动跳过)
  },
  "defaults": [ ... ]          // 首次运行的默认关注
}
```

> 桌面版配置位置:`%APPDATA%/fund-trend-monitor/config.json`(首次启动自动生成,改后重启生效)。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/funds` | 快照(全部关注基金估值+采样+源状态) |
| POST | `/api/funds/sync` | 立即同步一次 |
| POST/GET | `/api/funds/closing-report` | 手动推送/预览收盘预估报告 |
| GET | `/api/funds/history?code=&limit=` | 分钟采样(默认 240) |
| POST | `/api/funds/add` `{code,name}` | 关注(可只传 code 自动搜名) |
| POST | `/api/funds/remove` `{code}` | 取关 |
| POST | `/api/funds/rename` `{code,name}` | 改名 |
| GET | `/api/search?q=` | 基金搜索 |
| GET | `/api/funds/summary?code=` | 概要(双源合并) |
| GET | `/api/funds/nav-history?code=&page=` | 历史净值(东财 f10) |
| GET | `/api/sources` | 数据源/限流健康状态 |
| GET | `/api/stream` | SSE 实时推送(`tick`/`alert` 事件) |

## 目录结构

```
server.js            入口(双模式:CLI 直跑 / startApp() 供 Electron 嵌入)
electron/main.js     Electron 主进程(原生窗口 + 系统通知)
config.json          配置
src/
  util.js            HTTP/GBK/JSONP/开闭市/北京时间工具
  ratelimit.js       令牌桶/退避/健康度
  store.js           关注列表+分钟采样持久化 (data/*.json)
  monitor.js         每分钟同步/采样/趋势/提醒/收盘预估/SSE
  api.js             REST+SSE+静态文件
  assets.js          静态资源解析(磁盘/SEA 内嵌)
  sources/
    sina.js          新浪估值
    tencent.js       腾讯净值
    danjuan.js       蛋卷概要
    eastmoney.js     东财搜索/概要/历史净值
    registry.js      多源负载均衡/退避/缓存
public/              前端(原生 JS/SVG,无框架)
test/                node:test 单测(25+)
scripts/build-exe.js SEA 单文件打包
release/             electron-builder 产物(portable)
```

## 版本与自动更新

- 版本号在 `VERSION` 文件维护,CI 每次构建自动 patch+1 并打 tag 发布 release。
- 两个 exe 都内嵌版本号,启动后日志与 `/api/update` 可查。
- **自动更新机制**:客户端定时(默认 6h)查询 GitHub Releases,发现新版本 → 下载 `FundTrendMonitor*.exe` → SHA256 校验(`SHA256SUMS.txt`)→ 现役 exe 重命名留档(`*.old.*`)→ 新文件落位 → 重启生效。Electron 版额外支持**首跑自我安装**:portable exe 首次运行时把自身复制到 `%APPDATA%/FundTrendMonitor/FundTrendMonitor.exe`,后续更新替换该副本。
- 手动检查:界面 `📊 收盘预估` 旁的更新按钮(或 `POST /api/update/apply`、`POST /api/update/restart` 立即重启)。
- 也可在 `config.json` 关闭:`"update": { "enabled": false }`。

## CI(GitHub Actions)

`.github/workflows/build.yml`:推送到 main/master 自动 **测试 → 版本号+1 → 构建 SEA exe + Electron portable → 生成 SHA256SUMS → 提交版本号 → 发布 Release**。产物自动成为自动更新的下载源。

## 免责声明

本项目仅用于个人学习研究,数据来自公开接口,可能不准确或随时变更;不构成投资建议。请遵守目标网站的服务条款,勿用于商业爬取。
