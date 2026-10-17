# 架构概览

浏览器页面（dist）通过同源 HTTP API 访问 Node.js 服务；服务使用 Better Auth 管理身份和会话，使用 SQLite 保存账号和业务记录。当前使用本地模拟外部服务适配器。

```text
浏览器：HTML / CSS / ES Modules
          │ 同源 HTTP + HttpOnly Cookie
Node.js：账号、权限、免费组队、服务订单与维护任务
          │
SQLite：认证与业务持久化   本地附件存储
          │
受限环境部署：Caddy / systemd / 加密备份与恢复
```

- 端游和手游共用成熟组队实现，通过服务端渠道字段隔离招募、名片和相关记录，不区分 QQ/微信。
- 前端状态提示不能替代后端权限判断；请求来源、角色、参与关系、频率及状态转换由服务端检查。
- 游客是独立的受限用户身份，不是共享管理员；没有可找回的账号密码，不能用来证明真实身份。
- 订单与任务逻辑保留版本/重复请求控制和模拟收退流程，真实资金入口仍关闭。
- 数据保存在源码目录之外的运行目录，受数据锁保护；升级和部署需要先备份、核验完整性并保留回退。

此文是代码阅读地图，不表示系统已通过公开运营或合规验收。

## 从哪里开始读

| 入口 | 职责与需要注意的边界 |
| --- | --- |
| [server/index.mjs](../server/index.mjs) | 启动配置→运行锁与升级备份→模块装配→认证/请求边界→具体HTTP路由→退出清理。这里做路由编排，真实授权仍由业务模块核对 |
| [server/market.mjs](../server/market.mjs) | `createMarket`装配订单模块；先读`load/save/transaction`与版本控制，再看`command`操作分支、派单与支付任务。金额是整数分，SQL和事务边界不因排版改变 |
| [server/teams.mjs](../server/teams.mjs) / [team-profiles.mjs](../server/team-profiles.mjs) | 免费招募、成员关系和端游/手游资料隔离，不通过零元订单模拟免费组队 |
| [server/auth.mjs](../server/auth.mjs) / [security.mjs](../server/security.mjs) | Better Auth账号与会话、游客插件、二次验证和账号安全，不等于正式实名渠道 |
| [server/operations.mjs](../server/operations.mjs) / [payment-journal.mjs](../server/payment-journal.mjs) | 后台任务、重试与模拟渠道凭据；不是真实资金账本 |
| [server/providers/contracts.d.ts](../server/providers/contracts.d.ts) / [local.mjs](../server/providers/local.mjs) | 适配器接口意图与本地模拟实现；声明尚未由项目级类型检查验证 |

`index.mjs`和`market.mjs`仍是较大的模块。本轮只将密集单行展开为标准格式，加入可重复格式检查，保持业务代码的语法树等价；文件变长不等于业务复杂度已经降低。将来若确有新增路由或多人维护需求，再按既有模块边界逐步抽离，先明确依赖和事务范围，避免把鉴权或一致性散落到多个新文件。
