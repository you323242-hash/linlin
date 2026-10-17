const title = '致面试官的一封信';
const seenKey = 'delta-project-letter-v2';

export const projectLetter = `<article class="project-letter" data-kind="letter">
  <p class="project-letter-meta">个人实践项目介绍 · 周子涵 · 2026年10月15日</p>
  <p>项目源码：<a href="https://github.com/you323242-hash/linlin" target="_blank" rel="noopener noreferrer">GitHub 仓库 · 查看代码与运行说明 ↗</a></p>
  <p>尊敬的面试官：</p>
  <p>您好！感谢您抽出时间浏览我的项目网站。这是一个由我自主规划、借助 AI 工具辅助开发的游戏服务平台。我想借此介绍项目的设计思路、当前进展，以及自己在其中承担的工作。</p>
  <section><h3>从玩家需求出发</h3>
    <p>项目以《三角洲行动》玩家的组队需求为切入点。玩家可以通过游戏内招募、社群及陪玩平台寻找队友，但招募信息更新较快，玩法偏好也不尽相同，寻找合适队友仍有沟通和时间成本。</p>
    <p>现有陪玩平台已具备较为成熟的付费服务体系，而我更关注普通玩家的日常组队需求，以及免费匹配与付费服务进一步结合的可能。</p>
  </section>
  <section><h3>产品定位与业务设计</h3>
    <p>我将网站定位为<strong>以免费组队为基础、付费陪玩为延伸的游戏服务平台</strong>。免费板块围绕玩家资料展示、条件筛选、招募申请及小队沟通设计；付费板块则围绕下单、接单、服务计时、评价与售后梳理业务流程。</p>
    <p>这一模式希望先以较低门槛吸引目标玩家，再通过实际使用情况判断需求、决定投入方向。项目尚未获得充分的市场验证，现阶段更重视基础功能与用户需求的检验。</p>
  </section>
  <section><h3>当前进展与体验范围</h3>
    <p>网站已完成前后端、数据库及用户认证系统的基本建设，并部署至云服务器。免费组队已具备较完整的业务流程，付费订单等商业功能暂以模拟形式运行，不会真实扣款。</p>
    <p>项目主要采用 HTML、CSS、JavaScript、Node.js、SQLite 及 Better Auth，并对权限管理、业务流程测试和数据备份机制进行了完善。</p>
    <p class="project-letter-status">目前仍处于内部测试阶段。经营主体登记、网站备案及相关业务资质等准备工作尚未完成，部分功能和业务设想仍待验证。</p>
  </section>
  <section><h3>我承担的工作</h3>
    <p>我主要负责产品定位、需求分析、业务规则制定、功能规划、开发任务协调与测试验收，并借助 Codex、Claude 等 AI 工具完成代码实现及技术问题排查。</p>
    <p>项目经历了端游与手游分区、游客体验机制、免费组队优先开发等多次需求调整。这些实践让我对产品需求、技术实现、开发成本与业务运营之间的关系有了更具体的认识。</p>
  </section>
  <section><h3>后续计划与实践收获</h3>
    <p>下一阶段将优先推进相关手续，完善用户体验和运营规则，通过小范围用户测试评估匹配效率、用户反馈及持续使用情况。在具备相应运营条件后，计划逐步引入低价付费陪玩服务，完善评价与售后保障机制。</p>
    <p>长期方向将以实际需求为依据，通过与玩家、服务者持续沟通，调整服务内容及产品、运营模式。</p>
    <p>从需求构想到产品设计、技术落地与运营准备，这段经历使我积累了项目推进、业务分析和 AI 工具应用的实践经验，也让我更加重视需求判断、执行效率与实际成果之间的关系。</p>
    <p>我期待将这些经验运用到实际工作中，在企业的业务环境与团队协作中继续提升能力。如果有机会参加面试，我愿意进一步展示项目成果，介绍设计决策、个人承担的工作，以及项目目前的不足。</p>
  </section>
  <p>感谢您的阅读与考虑！</p>
  <div class="project-letter-signature"><p>此致<br>敬礼！</p><p>求职者：周子涵<br><time datetime="2026-10-15">2026年10月15日</time></p></div>
</article>`;

export function mountProjectLetter(show) {
  const footer = document.querySelector('footer nav');
  if (!footer) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'source-button project-letter-link';
  trigger.textContent = title;
  const open = () => show(title, projectLetter, trigger);
  trigger.addEventListener('click', open);
  footer.prepend(trigger);
  try { if (sessionStorage.getItem(seenKey) === 'shown') return; } catch { /* Reading remains available when storage is blocked. */ }
  const autoOpen = () => {
    if (document.querySelector('dialog[open]')) return;
    document.removeEventListener('close', autoOpen, true);
    show(title, projectLetter);
    try { sessionStorage.setItem(seenKey, 'shown'); } catch { /* Do not block the reading experience. */ }
  };
  // Wait for an active task's dialog to close instead of replacing its contents.
  document.addEventListener('close', autoOpen, true);
  autoOpen();
}
