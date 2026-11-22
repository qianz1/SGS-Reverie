/**
 * characters/zhangfei.js
 * 【张飞】的角色数据 + 技能【咆哮】实现（单角色单文件）。
 *
 * 新增角色时：复制本文件，改 data，并实现 skill 里的钩子即可，
 * 主循环会自动读取 SGS.Characters 下的所有角色。
 *
 * 技能钩子契约（player.js 会调用，未实现的钩子走默认规则）：
 *   shaLimit(player, defaultLimit) -> 本回合【杀】可用次数，默认 1
 *   asSha(player, card)            -> 该手牌能否当作【杀】使用，默认仅杀
 *   asShan(player, card)           -> 该手牌能否当作【闪】打出，默认仅闪
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  /** —— 角色数据 —— */
  const data = {
    id: 'zhangfei',
    name: '张飞',
    title: '万夫不当',
    faction: '蜀',       // 角色框左上角的势力标识
    image: 'SHU-ZhangFei.webp',  // 势力前缀 + 名字拼音；加载失败回退到 CSS 绘制
    maxHp: 4,
    avatar: '张',
    gender: 'male'       // 【雌雄双股剑】异性判定用
  };

  /** —— 技能实现：咆哮 —— */
  const skill = {
    name: '咆哮',
    titles: '咆哮',   // 技能按钮位列出全部技能；咆哮是被动锁定技，恒为灰色占位
    desc: '出牌阶段，你使用【杀】没有次数限制。',

    // 覆盖默认的「每回合 1 张杀」限制
    shaLimit(/* player, defaultLimit */) {
      return Infinity;
    },

    // 咆哮不改变牌的转化；【杀】家族（普通杀 / 火杀 / 雷杀）都能当杀
    asSha(player, card) {
      return SGS.Cards.isSha(card.type);
    },

    // 只有真正的【闪】能响应杀
    asShan(player, card) {
      return card.type === 'shan';
    }
  };

  Characters.zhangfei = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
