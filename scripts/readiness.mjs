import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { localConfig } from '../server/config.mjs';
import { REQUIRED_MIGRATIONS } from '../server/upgrade-backup.mjs';
import { inspectPaymentJournal } from '../server/payment-journal.mjs';

// Read-only, no secret values, no network calls and no implicit account creation.
try {
  const config=localConfig(), filename=path.join(config.dataDirectory,'auth.sqlite');
  const report={environment:config.environment,scope:'local-or-restricted-mock-only',productionReady:false,checks:[],providers:{payment:'mock',sms:'mock',ai:'mock',notification:'mock-outbox',storage:'private-local'},blockedBeforeLive:[
    '本命令仅检查当前数据目录；云端Linux/HTTPS与本地巡检已有专项证据，容量、跨设备、异地告警/恢复仍按docs/PUBLIC_BETA_GATES.md验收，不能由本报告推定',
    '经营主体、经营要求、素材授权、隐私及协议定稿待确认',
    '支付渠道须明确支持陪玩撮合、自然人服务者、先付款后匹配及换人',
    '抽成基数、手续费/退款成本承担、结算周期与质量阈值待负责人确认',
    '验证/找回Local与Mock流程已测试；真实手机号/微信/QQ归属和注销仍未完成；管理员二次验证须按目标环境实际验收',
    '模拟回执、双分录和只读对账已实现；旧任务无回执缺口不得补造或视为账本覆盖，真实回调/账本/渠道对账/分账/结算/提现尚未实现',
    'AI和社区复核保留为长期需求，当前不执行自动裁决',
  ]};
  report.checks.push({name:'database-present',ok:existsSync(filename)});
  if(existsSync(filename)){
    const db=new DatabaseSync(filename,{readOnly:true});
    try {
      report.checks.push({name:'database-integrity',ok:db.prepare('PRAGMA quick_check').get().quick_check==='ok' && db.prepare('PRAGMA foreign_key_check').all().length===0});
      const versions=db.prepare("SELECT 1 FROM sqlite_master WHERE name='app_migrations'").get()?db.prepare('SELECT id FROM app_migrations').all().map(r=>r.id):[];
      report.checks.push({name:'application-migrations',ok:REQUIRED_MIGRATIONS.every(id=>versions.includes(id)),versions});
      if(versions.includes('006-payment-journal')) {
        report.paymentJournal=inspectPaymentJournal(db);
        report.checks.push({name:'payment-journal-consistency',ok:report.paymentJournal.ok});
      }
      if(versions.includes('005-account-security')) {
        const total=db.prepare("SELECT count(*) n FROM user WHERE role='admin'").get().n;
        const unprotected=db.prepare("SELECT count(*) n FROM user WHERE role='admin' AND (COALESCE(twoFactorEnabled,0)<>1 OR NOT EXISTS(SELECT 1 FROM twoFactor t WHERE t.userId=user.id AND t.verified=1))").get().n;
        report.adminSecurity={accounts:total,notEnrolled:unprotected,requiresRecentSecondFactor:config.environment==='staging'};
        report.checks.push({name:'staging-admin-mfa',ok:config.environment!=='staging'||(total>0&&unprotected===0)});
      }
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='operation_alerts'").get())report.openOperationalAlerts=db.prepare("SELECT count(*) AS n FROM operation_alerts WHERE resolved_at IS NULL AND kind<>'attention'").get().n;
    }finally{db.close();}
  }
  report.checks.push({name:'auth-key-identity',ok:existsSync(path.join(config.dataDirectory,'auth-key.json'))});
  report.checks.push({name:'private-data',ok:!config.dataDirectory.startsWith(path.resolve('dist')+path.sep)});
  report.backup={encryptedKeyConfigured:!!process.env.BACKUP_KEY_FILE,externalAuthReferenceConfigured:!!process.env.AUTH_KEY_REF,offsiteRecoveryVerified:false};
  if(existsSync(path.join(config.dataDirectory,'environment.json')))report.directoryEnvironment=JSON.parse(readFileSync(path.join(config.dataDirectory,'environment.json'),'utf8')).environment;
  console.log(JSON.stringify(report,null,2));
  if(report.checks.some(c=>!c.ok))process.exitCode=1;
}catch{console.error('接入准备检查失败，请先运行本地环境检查；未打印配置值。');process.exitCode=1;}
