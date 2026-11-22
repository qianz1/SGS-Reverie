/**
 * characters/zhaoyun.js
 * 【赵云】的角色数据 + 技能【龙胆】实现（单角色单文件）。
 *
 * 技能钩子契约见 characters/zhangfei.js 顶部注释。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});
  const Characters = SGS.Characters || (SGS.Characters = {});

  /** —— 角色数据 —— */
  const data = {
    id: 'zhaoyun',
    name: '赵云',
    title: '少年将军',
    faction: '蜀',       // 角色框左上角的势力标识
    image: 'SHU-ZhaoYun.webp',   // 势力前缀 + 名字拼音；加载失败回退到 CSS 绘制
    maxHp: 4,
    avatar: '赵',
    gender: 'male'       // 【雌雄双股剑】异性判定用
  };

  /** —— 技能实现：龙胆 —— */
  const skill = {
    name: '龙胆',
    titles: '龙胆',
    desc: '你可以将【杀】当【闪】、【闪】当【杀】使用或打出。',

    // desc 含「可以」→ 属于需玩家主动发动的技能，ui.js 会给它单独一个技能按钮。
    // 转化不再随普通出牌自动生效，必须「点技能按钮 → 选牌 → 确认」三步完成。
    active: true,

    // 按钮点开后可选的转化方向；scenes 决定它出现在哪个交互场景：
    //   play    = 出牌阶段（把手牌当【杀】使用）
    //   respond = 响应阶段（杀→闪 响应【杀】/【万箭齐发】；
    //                       闪→杀 响应【南蛮入侵】/【决斗】）
    // 两个方向都登记在 respond，由 ui.js 按本次「需要哪种牌」(need) 过滤，
    // 因此新增群体锦囊时无需再改角色文件。
    conversions: [
      { from: 'shan', to: 'sha',  scenes: ['play', 'respond'], skill: '龙胆', label: '将【闪】当【杀】使用或打出' },
      { from: 'sha',  to: 'shan', scenes: ['play', 'respond'], skill: '龙胆', label: '将【杀】当【闪】使用或打出' }
    ],

    // 龙胆不改变出杀次数，沿用默认上限
    shaLimit(player, defaultLimit) {
      return defaultLimit;
    },

    // 【杀】家族（含【火杀】【雷杀】）与【闪】都能当【杀】使用
    asSha(player, card) {
      return SGS.Cards.isSha(card.type) || card.type === 'shan';
    },

    // 【杀】家族（含【火杀】【雷杀】）也能当【闪】打出
    asShan(player, card) {
      return card.type === 'shan' || SGS.Cards.isSha(card.type);
    }
  };

  Characters.zhaoyun = Object.assign({}, data, { skill: skill });
})(typeof window !== 'undefined' ? window : globalThis);
