# 开发与维护

## 启动

使用 Node.js 24+，执行 npm ci 和 npm start。默认仅监听本机 127.0.0.1:4174。首次生成的 .local/ 数据和密钥不会进入 Git；需要保留数据时应一起妥善备份原认证密钥，不要重新生成以替换已有库的密钥。

常用命令：npm run dev:check、npm run check、npm test、npm run seed:local。种子数据是公开测试资料，不是正式账号。

可参考 config/*.env.example。不要把任何真实凭据写入模板、README、问题反馈或日志。不同环境使用独立运行目录，禁止将本地种子库直接当线上数据。

## 测试与交付

测试使用独立合成数据；不要把真实用户库作为 AUTH_DATA_DIR 运行测试。backup、restore、capacity 等脚本有实际副作用，先读参数和源码，仅对自己的隔离夹具执行。

scripts/package-release.mjs 支持将当前源码打包到项目外全新目录，scripts/verify-release.mjs 核对清单。这种清单是完整性校验，不是数字签名。默认不需要运行源码导出工具即可启动网站。

scripts/recruitment-demo.mjs 是历史独立合成演示工具；普通网站已具备游客选项，不应再为正常使用创建招聘专用实例。常规 npm start 不使用该工具。

## 部署

仓库中 deploy/ 只有示例，必须按实际域名、证书、权限和服务账号审查后使用。不要提交真实 Caddyfile、环境文件、证书私钥或数据库。

发布前：检查版本与差异、备份和恢复、维护锁、低权限候选测试及数据完整性；发布后核对实际源码与健康状态，保留回退。Caddy 无配置变化不重启；有变化先 validate 再按部署方案处理。回滚代码不意味着可以用旧数据库覆盖新增用户数据。

production 入口尚未开放；不要删除该门禁或把模拟渠道改名当成真实渠道。
