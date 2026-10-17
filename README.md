# 三角洲玩家组队与服务平台

面向《三角洲行动》玩家的个人产品实践，以免费组队为基础，探索与游戏服务匹配衔接的业务流程。

我负责产品构思、业务规则与功能取舍、实际使用反馈和项目推进，借助Codex、Claude辅助完成代码实现、技术检查与迭代。

## 项目构思、个人参与与后续计划

| 文档 | 主要内容 |
| --- | --- |
| **[项目说明与个人实践复盘](docs/INTERVIEW_PROJECT_APPENDIX.md)** | 从构思到制作的过程、我的实际投入与反馈、订单流程、业务取舍，以及Codex与Claude协作 |
| **[后续运营思路](docs/运营构思与落地准备/01-运营思路.md)** | 免费组队优先、小范围真实试用、用户反馈与管理，以及未来付费服务的衔接 |
| **[主体、备案与正式渠道办理准备](docs/运营构思与落地准备/02-主体备案与渠道办理准备.md)** | 当前准备情况、尚未正式运营的原因，以及后续需要核实和办理的步骤 |

以上文档来自项目推进中的实际想法与决定；[运营构思目录](docs/运营构思与落地准备/README.md)进一步说明这些安排的形成过程和计划边界。

## 项目功能

- **免费组队**：端游/手游分区、游戏名片、招募筛选、申请与确认入队、小队沟通和组队记录。
- **账号与游客体验**：站内账号、独立游客身份、会话保持及访问权限管理。
- **模拟服务业务**：订单创建、模拟付款、匹配接单、服务计时、评价和售后。
- **运行与维护**：数据库持久化、任务重试、审计、加密备份恢复及状态检查。

项目包含前后端及数据库相关实现，已用于受限云端测试。当前真实资金和production入口保持关闭；QQ/微信登录及真实邮件、短信等外部渠道尚未正式接入。主体登记、备案与相关运营准备计划逐步推进，当前不提供正式营业服务。

## 技术实现

HTML、CSS、JavaScript ES Modules、Node.js、SQLite、Better Auth；受限部署使用Linux服务管理与Caddy。

前端直接维护在 `dist/`，不依赖旧框架构建。账号、组队、订单和权限由服务端处理。当前主体为JavaScript，已有适配器接口声明，尚未引入项目级TypeScript检查。

## 本地运行

需要 **Node.js 24或更高版本**，使用内置 `node:sqlite`。

```bash
git clone https://github.com/you323242-hash/linlin.git
cd linlin
npm ci
npm start
```

打开[免费组队页面](http://127.0.0.1:4174/teams.html)，可在登录框选择游客体验。首次启动在被Git忽略的 `.local/` 创建本地数据库和认证密钥。

可选的 `npm run seed:local` 用于生成合成测试角色；测试资料仅用于本地演示，不用于真实部署。配置参考 [config/local.env.example](config/local.env.example)，维护说明见[开发文档](docs/DEVELOPMENT.md)。

## 验证

```bash
npm run check
npm run format:check
npm test
```

2026-10-17的独立本地验证包括163个JavaScript文件语法检查、388项自动化测试及页面冒烟；核心格式整理经过语法树等价检查。实际CI结果可在[GitHub Actions](https://github.com/you323242-hash/linlin/actions)查看。

自动化和模拟环境检查覆盖特定范围，真实用户跨设备试用及正式渠道验收仍需继续。验证记录、当前HTTP运行证据和具体限制见[验证说明](docs/VERIFICATION.md)。

## 源码目录

| 目录 | 内容 |
| --- | --- |
| `dist/` | 页面、前端交互、样式和素材 |
| `server/` | HTTP/API、账号、组队、订单和权限 |
| `db/` | 数据结构参考 |
| `tests/` | 模块、HTTP、持久化、权限及恢复测试 |
| `scripts/` | 启动、测试、备份、交付和诊断工具 |
| `config/`、`deploy/` | 环境与部署模板 |
| `docs/` | 项目说明、架构、迭代和验证记录 |

仓库不包含真实用户数据库、运行凭据、上传附件或原始私有日志。测试账号及TLS夹具是公开合成资料，不用于真实环境。

[项目复盘](docs/INTERVIEW_PROJECT_APPENDIX.md) · [架构](docs/ARCHITECTURE.md) · [迭代记录](docs/ITERATION_HISTORY.md) · [项目状态](docs/PROJECT_STATUS.md) · [公测准备](docs/PUBLIC_BETA_GATES.md)

素材说明见 [dist/assets/original/README.md](dist/assets/original/README.md)。仓库未附开放源码授权许可证，第三方依赖遵循各自许可证。
