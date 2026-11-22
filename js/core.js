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

  /** Fisher-Yates 洗牌（返回新数组，不改动入参） */
  SGS.shuffle = function (arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
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

  /**
   * 行动顺序（座位号）：主公为「一」，其余玩家按逆时针依次「二、三…」。
   * 当前 1v1 不显示序号；扩展到多人局时由 UI 读取 player.seat 渲染。
   */
  SGS.SEAT_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八'];
  SGS.seatLabel = function (seat) {
    return SGS.SEAT_LABELS[seat - 1] || String(seat);
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

  /** 由 ui.js 注入的日志函数，纯逻辑层可在没有 UI 的环境里安全调用 */
  SGS.log = null;
})(typeof window !== 'undefined' ? window : globalThis);
