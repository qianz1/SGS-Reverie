/**
 * audio.js — 战斗界面背景音乐 + 角色技能 / 阵亡语音。
 *
 * 素材约定（文件缺失或解码失败一律静默跳过，绝不打断对局）：
 *   · BGM      assets/backgrounds/background-battle.m4a          （循环播放）
 *   · 技能语音 assets/voices/<势力大写>-<角色名拼音>_<技能拼音>.webm
 *              例：SHEN-ZhaoYun_LongHun.webm（神赵云·龙魂）
 *   · 阵亡语音 assets/voices/<势力大写>-<角色名拼音>_ZhenWang.webm
 *              例：SHEN-ZhaoYun_ZhenWang.webm
 *   · 使用牌语音 assets/voices/cards/NN【男|女】牌名.mp3
 *              例：01【男】杀.mp3 / 09【女】无懈可击.mp3
 *              按使用者 char.gender 区分男女（female → 女，其余 → 男）。
 *              只覆盖素材清单里的 20 种牌；【桃】/ 装备牌等没有对应文件，
 *              自动静默跳过。文件名含中文与【】，浏览器会对 src 自动做
 *              percent-encode，这里保留原样便于核对。
 *   · 作用音效 assets/sounds/NN【音效】名称.mp3
 *              01/02 普杀 -1/-2、03/04 雷杀 -1/-2、05/06 火杀 -1/-2
 *              （-1 = 受到 1 点伤害，-2 = 受到 2 点及以上伤害）、
 *              07 加血（所有形式）、08 自残（预留）、09 闪电、10 装备。
 *              受【火攻】的伤害固定走 06；【闪电】固定走 09。
 *              伤害按「最终实际点数」判定（藤甲加伤 / 白银狮子减伤之后）。
 *              由 Game.damage() / Game.healPlayer() / Game.useEquip() 触发，
 *              与「使用牌语音」「技能语音」是三条独立链路，互不冲突。
 *
 * <势力大写>-<角色名拼音> 直接复用角色立绘文件名（core.js 的
 * SGS.characterImageFile 已统一补势力前缀），去掉扩展名即可，所以
 * 新增角色只要按老规则放立绘，语音命名自动跟着走，不需要再登记一份。
 *
 * ★ 只播【角色技能】：技能名在 SKILL_PINYIN 里才播；【朱雀羽扇】【八卦阵】
 *   【丈八蛇矛】【寒冰剑】等装备技能没有对应语音，横幅照旧、音频不播。
 *   【八阵】是例外：它是角色锁定技，但发动点不在「装上装备」，而在
 *   Game.askRespond() 里「卧龙诸葛装备区无防具 + 需要【闪】+ 使用虚拟
 *   八卦阵判定」的那一刻（判定红 / 黑都算使用），由 game.js 显式
 *   announceSkill(target, '八阵') 触发 → 大字 + BaZhen 语音。
 *
 * ★ 浏览器自动播放策略：BGM 只在「点选择此将」这次真实用户手势之后启动
 *   （main.js 调用 startBgm）；play() 被拒绝 / 文件 404 / 无 Audio 环境
 *   全部静默降级，规则与动画链路完全不受影响。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  const BGM_URL = 'assets/backgrounds/background-battle.m4a';
  const VOICE_DIR = 'assets/voices/';
  const CARD_DIR = VOICE_DIR + 'cards/';
  const SOUND_DIR = 'assets/sounds/';
  const BGM_VOLUME = 0.34;
  const VOICE_VOLUME = 0.9;
  const CARD_VOLUME = 0.9;
  const EFFECT_VOLUME = 0.85;
  const SKILL_DEDUPE_MS = 420;
  const CARD_DEDUPE_MS = 260;

  /** 作用音效文件名（用户提供，放在 assets/sounds/） */
  const SOUND_FILE = {
    'sha-1':    '01【音效】普杀-1.mp3',
    'sha-2':    '02【音效】普杀-2.mp3',
    'leisha-1': '03【音效】雷杀-1.mp3',
    'leisha-2': '04【音效】雷杀-2.mp3',
    'huosha-1': '05【音效】火杀-1.mp3',
    'huosha-2': '06【音效】火杀-2.mp3',
    'heal':     '07【音效】加血.mp3',
    'self':     '08【音效】自残.mp3',
    'shandian': '09【音效】闪电.mp3',
    'equip':    '10【音效】装备.mp3'
  };

  /**
   * 使用 / 打出牌的语音：牌型 → [素材编号, 牌名]。
   * 只登记用户提供的 20 种 mp3；【桃】、装备牌、丈八蛇矛等没有素材，
   * playCard() 查不到就静默跳过，不打断对局。
   * 转化牌按「当作的牌型」播（♦ 当火【杀】→ 02 火杀，♠ 当【无懈可击】→ 09）。
   */
  const CARD_VOICE = {
    sha:              ['01', '杀'],
    huosha:           ['02', '火杀'],
    leisha:           ['03', '雷杀'],
    shan:             ['04', '闪'],
    juedou:           ['05', '决斗'],
    jiu:              ['06', '酒'],
    huogong:          ['07', '火攻'],
    shandian:         ['08', '闪电'],
    wuxiekeji:        ['09', '无懈可击'],
    shunshou:         ['10', '顺手牵羊'],
    guohe:            ['11', '过河拆桥'],
    lebusishu:        ['12', '乐不思蜀'],
    bingliangcunduan: ['13', '兵粮寸断'],
    nanman:           ['14', '南蛮入侵'],
    wanjian:          ['15', '万箭齐发'],
    taoyuan:          ['16', '桃园结义'],
    jiedaosharen:     ['17', '借刀杀人'],
    tiesuolianhuan:   ['18', '铁索连环'],
    wuzhong:          ['19', '无中生有'],
    wugufengdeng:     ['20', '五谷丰登']
  };
  /** 中文牌名反查，兼容调用方偶尔直接传 asName（'闪' / '无懈可击'） */
  const CARD_VOICE_BY_NAME = {};
  Object.keys(CARD_VOICE).forEach((k) => {
    CARD_VOICE_BY_NAME[CARD_VOICE[k][1]] = CARD_VOICE[k];
  });

  /** 角色技能中文名 → 文件名里的拼音段。装备技能不列入（无对应语音）。 */
  const SKILL_PINYIN = {
    '咆哮': 'PaoXiao',
    '龙胆': 'LongDan',
    '绝境': 'JueJing',
    '龙魂': 'LongHun',
    '渐营': 'JianYing',
    '矢北': 'ShiBei',
    '火计': 'HuoJi',
    '看破': 'KanPo',
    '八阵': 'BaZhen',
    '藏拙': 'CangZhuo',
    '连环': 'LianHuan',
    '涅槃': 'NiePan',
    '绝情': 'JueQing',
    '伤逝': 'ShangShi',
    '翦灭': 'JianMie',
    '三陈': 'SanChen',
    '昭讨': 'ZhaoTao',
    '破竹': 'PoZhu',
    '称象': 'ChengXiang',
    '仁心': 'RenXin'
  };

  let bgm = null;
  let bgmStarted = false;
  let bgmPaused = false;
  const failed = new Set();       // 探测/播放失败过的 url，不再反复请求
  const dead = new Set();         // 本局已播过阵亡语音的角色，避免重复
  let lastSkill = null;           // { key, t } 短时去重
  let lastCard = null;            // 使用牌语音的短时去重
  const calls = { bgm: [], skill: [], death: [], card: [], effect: [] };  // 供自测核对，不影响运行

  function AudioCtor() {
    return (typeof global.Audio === 'function') ? global.Audio : null;
  }

  function markFailed(url) {
    if (url) failed.add(url);
  }

  /** 统一构造 Audio 实例：失败静默，不抛到调用方 */
  function make(url, volume, loop) {
    const Ctor = AudioCtor();
    if (!Ctor || !url || failed.has(url)) return null;
    let a;
    try {
      a = new Ctor();
      a.src = url;
      a.volume = volume;
      a.loop = !!loop;
      a.preload = 'auto';
      if (typeof a.addEventListener === 'function') {
        a.addEventListener('error', () => markFailed(url));
      }
    } catch (e) {
      return null;
    }
    return a;
  }

  /** play() 可能返回 Promise 也可能不返回；被拒绝 / 抛错都静默 */
  function play(a, url) {
    if (!a || failed.has(url)) return;
    try {
      const p = a.play();
      // 自动播放被策略拒绝 ≠ 文件损坏：只静默，不记入 failed，
      // 否则下一次用户手势就再也不会重试了。文件 404 / 解码失败由
      // Audio 的 error 事件统一记入 failed。
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      /* 同步抛错也静默，不打断对局 */
    }
  }

  /** 角色语音文件名前缀：立绘名去扩展名，例如 SHEN-ZhaoYun */
  function voiceBase(playerOrChar) {
    const ch = (playerOrChar && playerOrChar.char) ? playerOrChar.char : playerOrChar;
    if (!ch) return null;
    let file = null;
    try {
      if (SGS.characterImageFile) file = SGS.characterImageFile(ch);
    } catch (e) { /* 回退到势力 + id */ }
    if (file) return String(file).replace(/\.[^.]*$/, '');
    const fp = SGS.factionPinyin ? SGS.factionPinyin(ch.faction) : 'QUN';
    return fp + '-' + (ch.voiceName || ch.id || 'Unknown');
  }

  /** 技能语音 url；未知技能（装备技 / 未登记角色技）返回 null → 不播 */
  function skillUrl(playerOrChar, skillName) {
    const base = voiceBase(playerOrChar);
    const py = SKILL_PINYIN[String(skillName || '').trim()];
    if (!base || !py) return null;
    return VOICE_DIR + base + '_' + py + '.webm';
  }

  /** 阵亡语音 url */
  function deathUrl(playerOrChar) {
    const base = voiceBase(playerOrChar);
    if (!base) return null;
    return VOICE_DIR + base + '_ZhenWang.webm';
  }

  /** 尽早建立 BGM 实例（preload），但不播放；无 Audio 环境安全 no-op */
  function init() {
    if (bgm || failed.has(BGM_URL)) return;
    bgm = make(BGM_URL, BGM_VOLUME, true);
  }

  /**
   * 启动战斗 BGM：必须在用户手势链路里调用（main.js 选将之后）。
   * 幂等；已暂停过则恢复。文件缺失 / 自动播放被拒都静默。
   */
  function startBgm() {
    // 用户手势是一次新的机会：preload 阶段若因环境（无音频设备 / 解码器
    // 未就绪）报过 error，这里清掉标记重试一次；文件真的 404 时 error
    // 会再次触发并重新记入 failed，不会反复骚扰。
    if (failed.has(BGM_URL)) {
      failed.delete(BGM_URL);
      bgmStarted = false;   // 强制这一次重新 play，不受上次幂等状态影响
    }
    init();
    if (!bgm) return;
    bgmPaused = false;
    if (bgmStarted && !bgm.paused) return;   // 已经在播，不重复 play
    bgmStarted = true;
    calls.bgm.push(BGM_URL);
    play(bgm, BGM_URL);
  }

  /** 结算画面出现时暂停 BGM（「再来一局」走 reload，会重新 startBgm） */
  function pauseBgm() {
    bgmPaused = true;
    if (!bgm) return;
    try { bgm.pause(); } catch (e) { /* 静默 */ }
  }

  /** 技能触发：与技能大字同一个入口（ui.skillFX）调用 */
  function playSkill(playerOrChar, skillName) {
    const url = skillUrl(playerOrChar, skillName);
    if (!url) return;                       // 装备技能 / 未登记 → 不播
    const ch = (playerOrChar && playerOrChar.char) ? playerOrChar.char : playerOrChar;
    const key = (ch && (ch.id || ch.name)) + '|' + skillName;
    const now = Date.now();
    if (lastSkill && lastSkill.key === key && now - lastSkill.t < SKILL_DEDUPE_MS) return;
    lastSkill = { key: key, t: now };
    calls.skill.push(url);
    play(make(url, VOICE_VOLUME, false), url);
  }

  /* ============================ 作用音效 ============================ */

  function soundUrl(key) {
    const f = SOUND_FILE[String(key || '').trim()];
    return f ? SOUND_DIR + f : null;
  }

  /**
   * 按「伤害属性 + 最终实际点数 + 来源」选作用音效文件。
   *   · opts.sound === 'shandian' → 09【闪电】（优先于雷电属性）
   *   · opts.sound === 'huogong'  → 06【火杀-2】（火攻固定走 06）
   *   · opts.sound === 'self'     → 08【自残】（预留，目前无来源）
   *   · 其余按属性：普通 01/02、雷 03/04、火 05/06；
   *     amount >= 2 走 -2，否则走 -1。
   * @param amount 最终实际伤害点数（藤甲 / 白银狮子结算之后）
   */
  function damageSoundKey(dmgType, amount, opts) {
    opts = opts || {};
    if (opts.sound === 'shandian') return 'shandian';
    if (opts.sound === 'huogong') return 'huosha-2';
    if (opts.sound === 'self') return 'self';
    const big = (amount || 0) >= 2;
    if (dmgType === 'fire') return big ? 'huosha-2' : 'huosha-1';
    if (dmgType === 'thunder') return big ? 'leisha-2' : 'leisha-1';
    return big ? 'sha-2' : 'sha-1';
  }

  /** 播放一个作用音效；未知 key / 文件失败 / 无 Audio 环境都静默 */
  function playEffect(key) {
    const url = soundUrl(key);
    if (!url) return;
    const a = make(url, EFFECT_VOLUME, false);
    if (!a) return;
    calls.effect.push(url);
    play(a, url);
  }

  /** 受到伤害（Game.damage 调用） */
  function playDamage(dmgType, amount, opts) {
    playEffect(damageSoundKey(dmgType, amount, opts));
  }
  /** 回复体力：所有形式（桃 / 酒自救 / 桃园结义 / 白银狮子 / 矢北…） */
  function playHeal() { playEffect('heal'); }
  /** 使用装备牌将其置入装备区 */
  function playEquip() { playEffect('equip'); }
  /** 自残伤害（预留：目前没有对自己造成伤害的技能） */
  function playSelfHurt() { playEffect('self'); }

  /**
   * 使用 / 打出牌的语音 url。
   * @param playerOrChar Player 或角色数据（读 char.gender）
   * @param type 牌型（或中文牌名，按 CARD_VOICE_BY_NAME 反查）
   */
  function cardUrl(playerOrChar, type) {
    const ch = (playerOrChar && playerOrChar.char) ? playerOrChar.char : playerOrChar;
    if (!ch) return null;
    const key = String(type || '').trim();
    const v = CARD_VOICE[key] || CARD_VOICE_BY_NAME[key];
    if (!v) return null;                    // 桃 / 装备 / 未登记牌 → 不播
    // ★ 性别区分：female → 女，其余（含 male / 未标注）→ 男。
    //   目前五个角色都是 male，但新增女角色只要写了 gender 就自动生效。
    const gender = ch.gender === 'female' ? '女' : '男';
    return CARD_DIR + v[0] + '【' + gender + '】' + v[1] + '.mp3';
  }

  /**
   * 角色「使用」或「打出」一张实体牌时播对应语音。
   * 与技能语音是两条独立链路：转化牌会同时有技能语音（如【看破】）和
   * 牌语音（【无懈可击】），这是设计如此，不是重复触发；同一张牌的
   * 同一条链路由 card.id + url 短时去重，避免包装层与内部各播一次。
   * 文件缺失 / 解码失败 / 无 Audio 环境一律静默。
   */
  function playCard(playerOrChar, type, card) {
    const url = cardUrl(playerOrChar, type);
    if (!url) return;
    const ch = (playerOrChar && playerOrChar.char) ? playerOrChar.char : playerOrChar;
    const key = (ch && (ch.id || ch.name)) + '|' + url + '|' +
      ((card && card.id) || '');
    const now = Date.now();
    if (lastCard && lastCard.key === key && now - lastCard.t < CARD_DEDUPE_MS) return;
    lastCard = { key: key, t: now };
    // make() 在「文件已标记失败 / 无 Audio 环境」时返回 null：
    // 这时不记入 calls.card，也不请求，避免自测把「没播」误判成「播了」。
    const a = make(url, CARD_VOLUME, false);
    if (!a) return;
    calls.card.push(url);
    play(a, url);
  }

  /** 角色阵亡：一局内同一角色只播一次 */
  function playDeath(playerOrChar) {
    const url = deathUrl(playerOrChar);
    if (!url) return;
    const ch = (playerOrChar && playerOrChar.char) ? playerOrChar.char : playerOrChar;
    const id = (ch && (ch.id || ch.name)) || '?';
    if (dead.has(id)) return;
    dead.add(id);
    calls.death.push(url);
    play(make(url, VOICE_VOLUME, false), url);
  }

  /** 仅供自测：清空内部状态，重新开始一局 */
  function reset() {
    if (bgm) { try { bgm.pause(); } catch (e) {} }
    bgm = null;
    bgmStarted = false;
    bgmPaused = false;
    failed.clear();
    dead.clear();
    lastSkill = null;
    lastCard = null;
    calls.bgm.length = 0;
    calls.skill.length = 0;
    calls.death.length = 0;
    calls.card.length = 0;
    calls.effect.length = 0;
  }

  SGS.Audio = {
    BGM_URL: BGM_URL,
    VOICE_DIR: VOICE_DIR,
    BGM_VOLUME: BGM_VOLUME,
    VOICE_VOLUME: VOICE_VOLUME,
    SKILL_PINYIN: SKILL_PINYIN,
    CARD_VOICE: CARD_VOICE,
    CARD_DIR: CARD_DIR,
    CARD_VOLUME: CARD_VOLUME,
    SOUND_DIR: SOUND_DIR,
    SOUND_FILE: SOUND_FILE,
    EFFECT_VOLUME: EFFECT_VOLUME,
    soundUrl: soundUrl,
    damageSoundKey: damageSoundKey,
    playEffect: playEffect,
    playDamage: playDamage,
    playHeal: playHeal,
    playEquip: playEquip,
    playSelfHurt: playSelfHurt,
    voiceBase: voiceBase,
    skillUrl: skillUrl,
    deathUrl: deathUrl,
    cardUrl: cardUrl,
    playCard: playCard,
    init: init,
    startBgm: startBgm,
    pauseBgm: pauseBgm,
    playSkill: playSkill,
    playDeath: playDeath,
    reset: reset,
    // 只读内部状态（测试 / 排查用）
    state: () => ({ bgmStarted, bgmPaused, failed: Array.from(failed),
                    dead: Array.from(dead), calls })
  };
})(typeof window !== 'undefined' ? window : globalThis);
