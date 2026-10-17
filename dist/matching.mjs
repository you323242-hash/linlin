// Shared labels and exact matching; free-form notes are not interpreted by AI.
export const TAG_SUGGESTIONS = ['耐心沟通', '积极报点', '新手友好', '轻松聊天', '安静配合', '战术协作', '任务协助', '节奏稳健', '路线讲解', '物资搜集', '主动交战', '娱乐开黑'];
export function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.length > 6) throw new Error('最多填写6个标签。');
  const tags = value.map(v => {
    if (typeof v !== 'string') throw new Error('标签格式无效。');
    const tag = v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag || [...tag].length > 12 || !/^[\p{Script=Han}a-z0-9 -]+$/u.test(tag)) throw new Error('每个标签1—12字，仅支持中文、字母、数字、空格和短横线。');
    return tag;
  });
  return [...new Set(tags)];
}
export const parseTags = text => normalizeTags(text.trim() ? text.split(/[,，、\n]/).map(v => v.trim()).filter(Boolean) : []);
export function matchFit(order, profile) {
  const matchedTags = (order.desiredTags || []).filter(t => (profile.tags || []).includes(t));
  return { matchedTags, trialMatched: !!(order.preferTrial && profile.trialAvailable) };
}

