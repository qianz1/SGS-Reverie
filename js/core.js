/**
 * core.js
 * 全局命名空间与通用工具。
 * 纯前端项目，不使用打包器：各文件按顺序通过 <script> 引入，
 * 统一挂载到 window.SGS 命名空间下，双击 index.html 即可运行。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  /** 异步等待，用于让阶段流转与日志有可读的节奏 */
  SGS.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Fisher-Yates 洗牌（返回新数组，不改动入参）。
   * rng 可注入：联机时由主机下发同一个随机源 / seed，保证两端算出
   * 完全一致的座次与牌序；不传时行为与原来一样用 Math.random。
   */
  SGS.shuffleWith = function (arr, rng) {
    const a = arr.slice();
    const rand = typeof rng === 'function' ? rng : Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  };

  /**
   * ★ 玩家侧可选项（顶栏勾选，仅本地对局生效，每局开始时由 UI 重置为默认）：
   *   autoTakeover —— AI 托管：勾选后自己的所有决策交给 AI 处理
   *   skillAuto    —— 技能名 → 是否「触发时自动发动」。缺省视为 true；
   *                   显式设为 false 时，到点改为询问「是否发动【X】」。
   *   放在全局而不是 Game 实例上：SGS.isDecider 是纯函数（部分专项把它
   *   单独绑到普通对象上跑，没有 Game 实例可用），必须能读到同一份开关。
   */
  SGS.Options = SGS.Options || { autoTakeover: false, skillAuto: {} };

  /**
   * ★ 默认「不自动发动」的技能名。缺省情况下 skillAutoEnabled 返回 true
   *   （与旧行为一致：伤逝 / 渐营一达成条件就自动摸牌），但【称象】这类
   *   需要玩家逐张权衡（点数和不大于 13）的技能，默认应由玩家自己决定，
   *   顶栏勾选框默认不勾。
   */
  SGS.SKILL_AUTO_DEFAULT_OFF = ['称象'];

  /** 该技能是否处于「自动发动」状态（未设置过按技能自己的默认值） */
  SGS.skillAutoEnabled = function (name) {
    const map = SGS.Options && SGS.Options.skillAuto;
    if (map && map[name] === false) return false;
    if (map && map[name] === true) return true;
    return (SGS.SKILL_AUTO_DEFAULT_OFF || []).indexOf(name) < 0;
  };

  /**
   * ★ 这个座位的决策要不要「问人」：本地真人 / 远端联机玩家都要挂起
   *   Promise 等输入，只有纯 AI 才自动决策。
   *   写成全局纯函数而不是只挂 Game.prototype：部分专项会把 Game 的方法
   *   单独绑到普通对象上跑，那里没有 Game 实例方法可用。
   *
   *   ★ AI 托管：本地真人勾选托管后视同纯 AI（isDecider = false），
   *   所有 `if (SGS.isDecider(...)) → 问人 / else → AI 决策` 的分支会
   *   自动改走 AI。远端玩家（isRemote）不受本地开关影响 —— 托管只接管
   *   自己这一台机器的操作。
   */
  SGS.isDecider = function (player) {
    if (!player) return false;
    if (SGS.Options && SGS.Options.autoTakeover &&
        player.isHuman && !player.isRemote) return false;
    return !!(player.isHuman || player.isRemote);
  };

  /** 默认洗牌入口：保持原有签名与行为（Math.random） */
  SGS.shuffle = function (arr) {
    return SGS.shuffleWith(arr, Math.random);
  };

  /** 自增 id 生成器 */
  SGS.uid = (function () {
    let n = 0;
    return (prefix) => (prefix || 'id') + '_' + ++n;
  })();

  /**
   * 一个完整回合的六个阶段（三国杀标准回合流程）。
   * 主循环 Game.runTurn() 会严格依次遍历本数组。
   */
  SGS.PHASES = [
    { key: 'prepare', name: '准备阶段' },
    { key: 'judge',   name: '判定阶段' },
    { key: 'draw',    name: '摸牌阶段' },
    { key: 'play',    name: '出牌阶段' },
    { key: 'discard', name: '弃牌阶段' },
    { key: 'end',     name: '结束阶段' }
  ];

  /** 座位号文字（一号位 = 先手），UI 读取 player.seat 渲染 */
  SGS.SEAT_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八'];
  SGS.seatLabel = function (seat) {
    return SGS.SEAT_LABELS[seat - 1] || String(seat);
  };

  /**
   * ★ 座次规则表：按「模式」分派 1..N 序号如何分配给场上角色。
   *
   * 目前只有 1v1 启用「随机分配」：生成 1..N 的序号洗牌后发给每个角色，
   * 再按序号升序重排 players —— players[0] 即一号位（先手），不再恒为玩家。
   *
   * 2v2 / 斗地主 / 军争的排序规则各不相同（交错座次、地主固定一号位、
   * 身份局按主公起算等），将来各加一条 rule 即可，绝不会误用 1v1 的洗牌。
   * 未登记的 mode 一律「按给定顺序编号、不随机」，因此自测与未接入模式的
   * 入口行为完全确定，不会因随机先手而偶发失败。
   *
   * @param {Array} players 场上角色
   * @param {string} mode 模式 id
   * @param {Function} [rng] 可注入随机源（联机主机同步 seed 时用）
   * @returns {Array} 按座位号升序排列的行动顺序数组
   */
  SGS.SEAT_RULES = {
    '1v1': function (list, rng) {
      const n = list.length;
      const seats = SGS.shuffleWith(
        Array.from({ length: n }, (_, i) => i + 1), rng);
      list.forEach((p, i) => { p.seat = seats[i]; });
      return list.slice().sort((a, b) => a.seat - b.seat);
    }
  };

  SGS.assignSeats = function (players, mode, rng) {
    const list = players.slice();
    const rule = mode && SGS.SEAT_RULES[mode];
    if (typeof rule !== 'function') {
      // 未登记模式：保持原顺序，只补序号（不偷偷随机、不重排）
      list.forEach((p, i) => { if (!p.seat) p.seat = i + 1; });
      return list;
    }
    const ordered = rule(list, rng);
    ordered.forEach((p, i) => {
      p.seat = Math.max(1, Number(p.seat) || i + 1);
    });
    return ordered;
  };

  /**
   * 座位距离（三国杀标准判定）：
   * 两名角色沿座位圈顺时针 / 逆时针两条路径中，较短一侧所隔的座位数。
   * 相邻 = 1，自己与自己 = 0；n 人局中 distance = min(|i-j|, n-|i-j|)。
   *
   * 这是纯函数（只吃人数与下标），便于单测；Game.distance() 在它之上叠加
   * 坐骑 / 装备的修正，因此将来接入 +1 马、-1 马时无需改动本函数。
   */
  SGS.seatDistance = function (n, i, j) {
    if (i === j || i < 0 || j < 0 || n <= 1) return 0;
    const diff = Math.abs(i - j);
    return Math.min(diff, n - diff);
  };

  /**
   * 角色图片文件名规则（素材放 assets/characters/）：
   *   <势力大写拼音>-<名字拼音>.webp
   * 例：晋·杜预 → JIN-DuYu.webp，蜀·张飞 → SHU-ZhangFei.webp。
   * 同名角色若存在不同势力版本，用不同前缀区分（如 JIN-DuYu / QUN-DuYu）。
   * 拼音逐字连写、每字首字母大写、不标声调；ü 的写法：需要写出 ü 时用 v
   * （Lv / Nv），ü 省略两点（j / q / x / y 后的 u）时用 u（故是 DuYu 不是 DuYv）。
   * 卡牌图片放 assets/cards/，按「卡牌名称拼音.webp」，不加势力前缀
   * （卡牌无势力）；另有通用牌背 assets/cards/back.webp。
   * 所有图片加载失败都会自动回退到 CSS 绘制的原界面。
   */
  SGS.FACTION_PINYIN = {
    '蜀': 'SHU', '魏': 'WEI', '吴': 'WU', '群': 'QUN', '晋': 'JIN', '神': 'SHEN'
  };
  SGS.factionPinyin = function (faction) {
    return SGS.FACTION_PINYIN[faction] || String(faction || 'QUN').toUpperCase();
  };

  /**
   * 生成角色图片文件名。
   * data.image 可以写完整名（SHU-ZhangFei.webp），也可以只写名字拼音
   * （ZhangFei.webp）——后者会按 data.faction 自动补上势力前缀，避免新增
   * 角色时漏写。已带「全大写字母-」前缀的文件名一律原样返回，不重复补。
   */
  SGS.characterImageFile = function (char) {
    if (!char || !char.image) return null;
    const file = char.image;
    if (/^[A-Z]+-/.test(file)) return file;
    return SGS.factionPinyin(char.faction) + '-' + file;
  };

  /**
   * ★ 角色在某个场景「实际发动」的转化技能名。
   *
   * 多技能角色不能一律用 skill.name：卧龙诸葛的 skill.name 是【火计】，
   * 但无懈响应那张黑牌转化发动的是【看破】。写日志时若取错，日志兜底
   * 会播错技能大字与语音（火计），再叠加看破的显式埋点就成了「同时播
   * 火计 + 看破两个音频」。
   *
   * 角色可用 skill.buttonName(scene) 区分场景（'play' / 'respond' /
   * 'brink' / 'wuxie'）；未实现时回退到 skill.name。日志、技能横幅、
   * 技能语音统一取这个值，保证「日志里写谁 → 就播谁」。
   */
  SGS.skillNameFor = function (player, scene) {
    const sk = player && (player.skill ||
      (player.char && player.char.skill));
    if (!sk) return null;
    if (typeof sk.buttonName === 'function') {
      const n = sk.buttonName(scene || 'play');
      if (n) return n;
    }
    return sk.name || null;
  };

  /**
   * ★「限定技 / 一次性主动技」的统一查询入口。
   * 角色在自己的 skill.actions 里声明 {name, scenes, usable?, run(game,player,scene)}：
   * UI 用它点亮右下技能按钮，Game 用它分发行动，AI 用它决定是否发动。
   * 全部只读玩家当前 skill 视图，因此涅槃后动态获得的技能自动参与。
   */
  SGS.findSkillAction = function (player, name, scene) {
    const sk = player && (player.skill || (player.char && player.char.skill));
    if (!sk || !name || !sk.actions) return null;
    const sc = scene || 'play';
    return sk.actions.find((a) => a && a.name === name &&
      (a.scenes || ['play']).indexOf(sc) >= 0) || null;
  };

  /** 这个一次性技能此刻能否发动（每局一次的状态记在 player.usedSkillActions） */
  SGS.canUseSkillAction = function (player, name, scene) {
    const action = SGS.findSkillAction(player, name, scene);
    if (!action) return false;
    // once!==false 的是限定技（每局一次）；翦灭这类「出牌阶段限一次」
    // 自己用 usable 判断本回合状态，不写进 usedSkillActions。
    if (action.once !== false &&
        player && player.usedSkillActions && player.usedSkillActions[name]) return false;
    if (typeof action.usable === 'function' &&
        !action.usable(player, scene || 'play')) return false;
    return true;
  };

  /** 当前场景所有可发动的一次性技能 */
  SGS.availableSkillActions = function (player, scene) {
    const sk = player && (player.skill || (player.char && player.char.skill));
    if (!sk || !sk.actions) return [];
    return sk.actions.filter((a) => a && SGS.canUseSkillAction(player, a.name, scene));
  };

  /** 由 ui.js 注入的日志函数，纯逻辑层可在没有 UI 的环境里安全调用 */
  SGS.log = null;

  /**
   * 由 Game 注入的「手牌离手」回调：Player.removeCard() 移走手牌后触发。
   * 【伤逝】的触发条件是「手牌数小于 X 后」，所以必须挂在这里而不是
   * 只挂失血钩子。同一时刻只有一个权威 Game，回调直接指向它的排队入口
   * （Game.queueHandBelowX —— 只登记，等当前同步流程走完再结算，避免摸牌
   * 动画插进调用方的动画里）；没有 Game（纯 Player 自测）时保持 null，安全跳过。
   */
  SGS.onHandRemoved = null;
})(typeof window !== 'undefined' ? window : globalThis);
