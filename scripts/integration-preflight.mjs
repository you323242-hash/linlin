import { inspectIntegrationPreparation } from '../server/integrations.mjs';
try {
  const report = inspectIntegrationPreparation();
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(report.secretFiles).includes('invalid-file')) process.exitCode = 1;
} catch { console.error('渠道准备检查失败：真实渠道不能直接启用；未输出配置或密钥。'); process.exitCode = 1; }
