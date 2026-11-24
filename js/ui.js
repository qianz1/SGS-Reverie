/**
 * ui.js
 * 界面渲染 + 玩家交互。
 * 把「等待玩家操作」包装成 Promise，主循环因此可以写成线性的 async 流程。
 * 本文件是唯一直接操作 DOM 的地方。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  const $ = (id) => document.getElementById(id);

  /**
   * 「可以」类主动技能：
   * 技能描述含「可以」（或显式 active:true）且声明了 conversions 时，
   * 单独给一个技能按钮；转化必须点按钮后选牌发动，不再随普通出牌自动生效。
   * 这样以后新增「可以…」技能，只要声明 conversions 就自动拥有按钮。
   */
  function activeSkill(player) {
    const s = player && player.skill;
    if (!s || s.active === false) return null;
    const byDesc = /可以/.test(s.desc || '');
    if (!s.active && !byDesc) return null;
    return (s.conversions && s.conversions.length) ? s : null;
  }

  /**
   * 当前场景下可用的转化项。
   * scene：'play' / 'respond' / 'brink' / 'wuxie'（角色 conversions 的 scenes）。
   * need：本次需要的牌型，可传单个字符串或数组；为空表示不过滤。
   *   play    传 ['sha','tao']：把手牌当杀 / 当桃主动使用（【龙魂】♥ 当桃）
   *   respond 按实际索要的牌过滤：万箭齐发要【闪】、南蛮入侵/决斗要【杀】
   *   brink   【桃】、wuxie 【无懈可击】 —— 濒死与无懈响应也走同一个技能按钮
   * ★ from 可以是牌型（龙胆 'shan'），也可以是花色（龙魂 '♥'），统一交给
   *   SGS.Cards.matchesFrom()；合法性由 Player.canUseAsType() 复核角色钩子。
   */
  function conversionsFor(player, scene, need, skillName) {
    const s = activeSkill(player);
    if (!s) return [];
    const needs = need ? (Array.isArray(need) ? need : [need]) : null;
    return s.conversions.filter((c) =>
      (c.scenes || ['play']).indexOf(scene) >= 0 &&
      (!needs || needs.indexOf(c.to) >= 0) &&
      // ★ 点右下某个技能按钮进入选牌后，只列这个技能自己的转化方向，
      //   不会把同角色其它技能的方向混进来（如青龙界面同时点亮多个技能时）。
      (!skillName || (c.skill || s.name) === skillName) &&
      // ★ 出牌阶段不能主动「使用」【闪】/【无懈可击】—— 它们是响应专用牌型。
      //   【龙胆】的「杀→闪」标了 scenes:['play','respond'] 只是为了响应复用，
      //   放开 play 的牌型过滤后必须在这里排除，否则技能按钮会多出无效方向。
      !(scene === 'play' && (c.to === 'shan' || c.to === 'wuxiekeji'))
    );
  }

  /** 这张手牌在当前场景能否经技能转化（同时复核角色的技能钩子） */
  function findConversion(player, card, scene, need, skillName) {
    if (typeof player.canUseAsType !== 'function') return null;
    return conversionsFor(player, scene, need, skillName).find(
      (c) => SGS.Cards.matchesFrom(card, c.from) &&
        player.canUseAsType(card, c.to)
    ) || null;
  }

  /**
   * 角色框里显示的名字：只写名字、不叠势力（【神】赵云 → 「赵云」）。
   * 角色数据可用 displayName 覆盖；势力由左上角势力标识表示。
   * 规则层 / 日志仍用完整的 char.name 区分同名不同势力版本。
   */
  function displayNameOf(p) {
    const ch = p && p.char ? p.char : (p || {});
    return ch.displayName || p.name || ch.name || '';
  }

  /**
   * 角色介绍（信息浮层 / 选将卡片）里的名字：「势力·名字」。
   * 神赵云 → 「神·赵云」，蜀张飞 → 「蜀·张飞」，
   * 卧龙诸葛 → 「蜀·卧龙诸葛」（角色数据用 introName 指定介绍名）。
   * 称号单独一行，不并入名字；这样同名不同势力版本一眼可分。
   */
  function introNameOf(p) {
    const ch = p && p.char ? p.char : (p || {});
    const faction = ch.faction || '群';
    return faction + '·' + (ch.introName || displayNameOf(p));
  }

  /**
   * 技能按钮在当前场景显示的短名。多技能角色可覆盖 buttonName(scene)：
   * 【卧龙诸葛】出牌阶段是「火计」，无懈响应时是「看破」。
   */
  function skillButtonName(skill, scene) {
    if (!skill) return '';
    if (typeof skill.buttonName === 'function') {
      return skill.buttonName(scene) || skill.name;
    }
    return skill.name;
  }

  /**
   * 转化后的牌此刻是否真的可用。
   * 【杀】要看出杀次数，【桃】要看是否满血；其余（闪 / 无懈等）不受限。
   * 右下技能按钮、技能选牌的确认按钮、确认前的复核都读这一处，
   * 保证「按钮变灰」与「规则层拒绝」的口径完全一致。
   */
  function conversionUsable(player, conv, scene, noShaCount) {
    if (!conv || !player) return false;
    // 出牌阶段「使用」杀才计次数；响应阶段「打出」杀不受次数限制。
    // noShaCount：青龙偃月刀追加杀是技能额外提供的，不占常规次数。
    if (conv.to === 'sha' && scene === 'play' && !noShaCount &&
        !player.canPlaySha()) return false;
    if (conv.to === 'tao' && player.hp >= player.maxHp) return false;
    if (conv.to === 'jiu' && scene === 'play' && player.jiuUsed) return false;
    // ★【渐营】：出牌阶段限一次「当任意基本牌」，且至少要有一种基本牌此刻可用。
    //   qinglong（【青龙偃月刀】追加杀）同样发生在出牌阶段，满足渐营条件；
    //   追加的杀不占常规出杀次数，所以不必再检查 canPlaySha()。
    if (conv.to === 'basic') {
      if (noShaCount) return !player.jianyingUsed;
      return !player.jianyingUsed && (
        player.canPlaySha() || player.hp < player.maxHp || !player.jiuUsed
      );
    }
    // 【火计】红→火攻 /【看破】黑→无懈可击：合法性交给规则层 canUse 复核
    return true;
  }

  /**
   * ★ 一名角色的**全部**技能名。优先按 skill.titles「·」拆分（角色介绍里
   *   也是这个口径），单技能角色回退 skill.name。张飞 / 赵云已补 titles。
   *   返回顺序 = 角色卡上技能展示顺序，按钮位照此竖排。
   */
  function skillNamesOf(player) {
    const sk = player && player.skill;
    if (!sk) return [];
    const src = sk.titles || sk.name || '';
    const parts = String(src).split(/[\u00b7|\uff5c\s\u3001,]+/)
      .map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : (sk.name ? [String(sk.name).trim()] : []);
  }

  /**
   * ★ 当前是否存在「正在结算、可被【无懈可击】抵消的目标锦囊牌」。
   *   只有 waitWuXie 构造的无懈响应询问界面才有（card / source / 上一张无懈），
   *   出牌阶段 mode='play' 恒为 false —— 所以【无懈可击】在出牌阶段
   *   【使用】按钮一律置灰，与满血用桃 / 杀次数用完同口径。
   */
  function hasWuXieTarget(pd) {
    return !!(pd && pd.mode === 'wuxie' &&
      (pd.card || pd.source || pd.lastWuXie));
  }

  /** 这张牌是否是响应专用牌（目前只有【无懈可击】：cards.js 标 responseOnly） */
  function isResponseOnly(card) {
    return !!(card && SGS.Cards.defs[card.type] &&
      SGS.Cards.defs[card.type].responseOnly);
  }

  /** 某个技能在当前场景的转化方向（conversions 用 skill 字段归到技能名下） */
  function skillConversionsFor(player, scene, need, name) {
    const sk = player && player.skill;
    if (!sk) return [];
    return conversionsFor(player, scene, need)
      .filter((c) => (c.skill || sk.name) === name);
  }

  /**
   * ★ 全部技能按钮状态：每个技能都出一条，当前条件下无法发动 / 属于被动
   *   锁定技（咆哮 / 绝境 / 矢北 / 八阵 / 藏拙）的一律 enabled=false，
   *   由 pushSkillButtons 渲染成灰色占位，玩家一眼看得到「我有哪些技能」。
   *   可发动还要同时满足：有场景匹配的转化方向、conversionUsable 通过、
   *   手里 / 装备区真有能转成该方向的牌。
   */
  function skillButtonStates(player, scene, need, noShaCount) {
    const sk = player && player.skill;
    if (!sk) return [];
    // ★「牌」= 手牌 + 装备区（不含判定区）：装备栏里的素材也要算进来
    const pool = (SGS.Zones && SGS.Zones.conversionCards)
      ? SGS.Zones.conversionCards(player).map((e) => e.card)
      : (player.hand || []).slice();
    return skillNamesOf(player).map((name) => {
      const convs = skillConversionsFor(player, scene, need, name);
      const canConvert = convs.some((c) =>
        conversionUsable(player, c, scene, noShaCount) &&
        pool.some((h) => SGS.Cards.matchesFrom(h, c.from) &&
          (typeof player.canUseAsType !== 'function' || player.canUseAsType(h, c.to)))
      );
      // ★ 一次性主动技（【涅槃】）：不依赖手牌素材，只要本局没用过就点亮
      const action = SGS.canUseSkillAction(player, name, scene);
      return { name: name, enabled: canConvert || action, action: action };
    });
  }

  /**
   * 把全部技能按钮压进操作列表：可发动的进右下技能位并可点，其余 disabled
   * 变灰。forceDisabled 用于「正在一次转化里 / 普通选牌界面」等不能中途
   * 再发动技能的场合，仍完整展示但全灰。
   */
  function pushSkillButtons(list, ui, pd, scene, need, opts) {
    opts = opts || {};
    const states = skillButtonStates(pd.player, scene, need, opts.noShaCount);
    states.forEach((st) => {
      if (st.enabled && !opts.forceDisabled) {
        // 「可以」类主动技 → 选牌转化；一次性主动技（涅槃）→ 直接发动
        const isAction = !!(st.action &&
          SGS.findSkillAction(pd.player, st.name, scene));
        list.push({
          label: st.name, cls: 'skill', slot: 'skill',
          onClick: isAction
            ? () => ui.invokeSkillAction(pd, scene, st.name)
            : () => ui.openSkill(pd, scene, st.name)
        });
      } else {
        list.push({
          label: st.name, cls: 'skill skill-off', slot: 'skill',
          disabled: true
        });
      }
    });
    return states.length;
  }

  /** HTML 文本转义（选将卡片拼接用，角色数据均为内部数据，防御性处理） */
  function escText(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 开局主界面四个模式的显示名（未开放提示用） */
  const MODE_LABELS = {
    '1v1': '1v1 单挑', '2v2': '2v2 组队',
    'ddz': '斗地主', 'junzheng': '军争'
  };

  /** 响应按钮文案：统一成「使用【X】」 */
  function respondAction(need) {
    return '使用【' + SGS.Cards.nameOf(need || 'shan') + '】';
  }

  /** 响应时的引导文案（杀 / 万箭齐发 / 南蛮入侵 / 决斗 共用） */
  function respondHint(player, need, reason, selected) {
    need = need || 'shan';
    reason = reason || '杀';
    const needName = SGS.Cards.nameOf(need);
    const act = respondAction(need);
    // ★【丈八蛇矛】：只在索要【杀】的响应里提示，且至少要有两张手牌
    const zhangba = need === 'sha' && player.hand.length >= 2 &&
      SGS.Equipment && SGS.Equipment.hasZhangba(player);
    const zb = zhangba ? '，或点左侧武器栏的【丈八蛇矛】用两张手牌当【杀】' : '';
    if (selected) return '已选【' + needName + '】，点上方操作区的【' + act + '】确认响应。';
    // need='sha' 时【火杀】【雷杀】也算可用的杀
    const has = player.hand.some((c) => SGS.Cards.matchesRespond(c, need));
    const skill = activeSkill(player);
    const canConvert = !!skill &&
      player.hand.some((c) => findConversion(player, c, 'respond', need));
    const skillName = skillButtonName(skill, 'respond');
    if (has && canConvert) {
      return '【' + reason + '】指向你！直接点选一张【' + needName + '】→ ' + act +
        '，或点【' + skillName + '】用其他牌当【' + needName + '】' + zb + '。';
    }
    if (has) {
      return '【' + reason + '】指向你！直接点选一张【' + needName + '】→ ' + act +
        '，或选择不出' + zb + '。';
    }
    if (canConvert) {
      return '【' + reason + '】指向你！没有【' + needName + '】，可点【' + skillName +
        '】用其他牌当【' + needName + '】' + zb + '。';
    }
    if (zhangba) {
      return '【' + reason + '】指向你！没有【' + needName +
        '】，可点左侧武器栏的【丈八蛇矛】用两张手牌当【杀】。';
    }
    return '【' + reason + '】指向你！没有可用的【' + needName + '】，只能承受伤害。';
  }

  /** 取某个元素最近的指定 class 祖先（图片加载事件的兜底处理用） */
  function closestByClass(el, cls) {
    return el && typeof el.closest === 'function' ? el.closest('.' + cls) : null;
  }

  class UI {
    constructor() {
      this.game = null;
      this.pending = null; // 当前正在等待的交互
      // 图片 UI 探测结果：只有预加载成功的素材才会渲染，失败一律回退到 CSS 绘制
      // back：assets/cards/back.webp（背面朝上移动时用），失败回退 CSS 牌背
      this.art = { characters: {}, cards: {}, marks: {}, back: null };
      // ★ 手牌自动 FLIP：render() 重建 #me-hand 前后自动让旧牌平滑滑到新位置。
      //   生成令牌避免连续 render 时旧清理任务误清新动画；
      //   suppress 供 flipInsertIntoHand 使用（它自己已做让位，别叠加两次）。
      this._handFlipGen = 0;
      this._handFlipSuppress = false;
      // ★ 正在「离手飞行」的牌 id → 起飞时间戳。手牌渲染时把它们当作已经
      //   不在手里，直到权威手牌数据里真的没有它们（见 visibleHand）。
      this._departing = {};
    }

    init() {
      // 注入全局日志函数，供纯逻辑层调用
      SGS.log = (msg, cls) => this.log(msg, cls);

      $('btn-restart').addEventListener('click', () => location.reload());
      $('btn-again').addEventListener('click', () => location.reload());

      // 玩家手牌区用事件委托，避免每次 render 重复解绑
      $('me-hand').addEventListener('click', (e) => {
        const el = e.target.closest('.card');
        if (el && el.dataset.id) this.onCardClick(el.dataset.id);
      });

      // 窗口尺寸变化时重新计算 >8 张手牌的叠放间距
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', () => {
          if (this.game) this.layoutHand(this.game.human.hand.length);
          this.layoutShowcase();
        });
      }

      // 目标选择：点击高亮的角色卡确定目标（多人局按 data-player 扩展）
      // ★ 仅在非选目标状态时，点击才切换「角色信息」浮层（hover 由 CSS 负责）。
      //   选目标期间点击只选目标：不弹出介绍，也不留下 info-open 状态，
      //   顺手把之前已打开的两张浮层收起，避免遮挡目标高亮。
      ['ai-area', 'me-area'].forEach((id) => {
        const el = $(id);
        if (el && el.addEventListener) {
          el.addEventListener('click', () => {
            const mode = this.pending && this.pending.mode;
            const selecting = mode === 'target' || mode === 'targets' ||
              mode === 'chainTargets';
            this.onHeroClick(el.dataset.player);
            const other = $(id === 'ai-area' ? 'me-area' : 'ai-area');
            if (other && other.classList) other.classList.remove('info-open');
            clearTimeout(el._infoTimer);
            if (selecting) {
              el.classList.remove('info-open');
              return;
            }
            el.classList.toggle('info-open');
            el._infoTimer = setTimeout(() => {
              if (el.classList) el.classList.remove('info-open');
            }, 4000);
          });
        }
      });

      // 装备区：点玩家自己的「武器」栏发动【丈八蛇矛】主动转化
      const eqBox = $('me-equip-area');
      if (eqBox && eqBox.addEventListener) {
        eqBox.addEventListener('click', (e) => {
          const t = e.target;
          const slotEl = t && typeof t.closest === 'function'
            ? t.closest('.equip-slot') : null;
          if (slotEl && slotEl.dataset && slotEl.dataset.slot) {
            this.onEquipSlotClick(slotEl.dataset.slot);
          }
        });
      }

      // 目标牌区面板：点牌背选中 / 点确认结算
      const tp = $('target-panel');
      if (tp && tp.addEventListener) {
        tp.addEventListener('click', (e) => {
          const t = e.target;
          if (!t || typeof t.closest !== 'function') return;
          if (t.closest('#tp-confirm')) { this.confirmTrickCard(); return; }
          if (t.closest('#tp-cancel')) { this.cancelTrickCard(); return; }
          const cardEl = t.closest('.tp-card');
          if (cardEl && cardEl.dataset.id) this.onTargetCardClick(cardEl.dataset.id);
        });
      }

      // 五谷丰登选牌面板：一栏正面牌，点一下即选（无需确认）
      const wp = $('wugu-panel');
      if (wp && wp.addEventListener) {
        wp.addEventListener('click', (e) => {
          const t = e.target;
          if (!t || typeof t.closest !== 'function') return;
          const cardEl = t.closest('.wugu-card');
          if (cardEl && cardEl.dataset.id) this.onWuguCardClick(cardEl.dataset.id);
        });
      }

      // ★【火计·火攻】查看目标手牌面板：点一张选为要展示的牌。
      //   面板里的牌是「正面」（使用者可以看见），点选不拿走牌。
      const pp = $('huogong-peek-panel');
      if (pp && pp.addEventListener) {
        pp.addEventListener('click', (e) => {
          const t = e.target;
          if (!t || typeof t.closest !== 'function') return;
          const cardEl = t.closest('.peek-card');
          if (cardEl && cardEl.dataset.id) this.onPeekCardClick(cardEl.dataset.id);
        });
      }

      this.bindReadOnlyUI();
      this.bindArtEvents();
      this.probeArt();
      this.probeSkillFont();
      // 战斗 BGM：这里只建立实例 / preload，真正 play() 由选将后的用户手势启动
      try { if (SGS.Audio && SGS.Audio.init) SGS.Audio.init(); }
      catch (e) { /* 音频不可用不影响界面 */ }
    }

    /**
     * ★ 只读 UI 的 JS 兜底：少数 WebView / 旧内核会无视 CSS 的
     *   user-select:none，这里在 document 层再拦一次。
     *
     *   · selectstart：拖过标题 / 日志 / 角色框不会拉出蓝色选区
     *   · dragstart  ：图片、卡牌不会被系统原生拖走或「另存为」
     *   · contextmenu：只在图片与背景层上拦右键菜单（避免「复制图片 /
     *     存储图像」），普通区域右键仍保留，不挡调试
     *
     *   输入控件（选将搜索框等）一律放行，保证仍可聚焦、输入、选中与粘贴。
     *   卡牌点选 / 角色框点选 / 自己用 Pointer Events 实现的拖动排序
     *   都不是这些事件，完全不受影响；无 DOM 的自测环境静默跳过。
     */
    bindReadOnlyUI() {
      if (typeof document === 'undefined' ||
          typeof document.addEventListener !== 'function') return;
      const editable = (t) => {
        if (!t || typeof t.closest !== 'function') return false;
        try { return !!t.closest('input, textarea, [contenteditable="true"]'); }
        catch (e) { return false; }
      };
      const block = (e) => {
        if (!e || editable(e.target)) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
      };
      document.addEventListener('selectstart', block);
      document.addEventListener('dragstart', block);
      document.addEventListener('contextmenu', (e) => {
        const t = e && e.target;
        if (!t || typeof t.closest !== 'function') return;
        let onArt = false;
        try {
          onArt = !!t.closest('img, .mode-bg-wrap, .start-bg-wrap, .battle-bg-wrap');
        } catch (err) { onArt = false; }
        if (onArt && typeof e.preventDefault === 'function') e.preventDefault();
      });
    }

    /**
     * ★ 技能大字字体：assets/fonts/HanYiWeiBeiJian-1.woff2。
     * 用 CSS Font Loading API 探测，只有真正加载成功才给 #app 加
     * .skill-font-ready；文件缺失 / 解码失败 / API 不可用 / 无 DOM 环境
     * 一律不加类 → .skill-banner 保持主题常规字体（CSS 字体栈也有兜底）。
     */
    probeSkillFont() {
      try {
        const fonts = (typeof document !== 'undefined') && document.fonts;
        const app = $('app');
        if (!fonts || typeof fonts.load !== 'function' || !app) return;
        const p = fonts.load('1em "SGSHanYiWeiBei"');
        if (!p || typeof p.then !== 'function') return;
        p.then((faces) => {
          if (faces && faces.length && app.classList) app.classList.add('skill-font-ready');
        }).catch(() => { /* 保持常规字体 */ });
      } catch (e) { /* 保持常规字体 */ }
    }

    /**
     * ★ 角色技能名白名单：从 SGS.Characters 动态收集（skill.name + titles
     *   按「·」拆分）。装备技能（八卦阵 / 朱雀羽扇 / 丈八蛇矛 / 寒冰剑 /
     *   贯石斧 / 青龙偃月刀…）一律不在其中，横幅与语音都不播。
     *   新增角色技能自动纳入，不需要维护装备技能黑名单。
     */
    characterSkillNames() {
      const map = {};
      const chars = (typeof SGS !== 'undefined' && SGS.Characters) || {};
      Object.keys(chars).forEach((k) => {
        const sk = chars[k] && chars[k].skill;
        if (!sk) return;
        if (sk.name) map[String(sk.name).trim()] = true;
        if (sk.titles) String(sk.titles).split(/[\u00b7|\uff5c\s\u3001,]+/)
          .forEach((n) => { const t = n.trim(); if (t) map[t] = true; });
        // ★ 局中才获得的技能（如【涅槃】三选一）同样要能播横幅 / 语音
        Object.keys(sk.fragments || {}).forEach((n) => { map[n] = true; });
      });
      return map;
    }

    /**
     * 从日志里兜底识别「某角色发动【技能】」。
     * 所有逻辑层的 SGS.log 都经 ui.log 注入，角色技能（渐营 / 矢北 / 绝境 /
     * 火计 / 龙魂 / 龙胆…）无需逐个埋点就能自动播动画。
     * 只认「玩家名 + 发动【X】」开头，warn 提示与无主语的【X】说明不会误触发；
     * ★ 装备技能日志（发动【八卦阵】等）即使匹配也直接跳过——只有角色技能播。
     */
    maybeSkillFX(msg, cls) {
      if (cls === 'warn' || !this.game) return;
      const m = String(msg).match(/^(.+?)\s*发动【([^】]+)】/);
      if (!m) return;
      const who = m[1].trim(), name = m[2].trim();
      if (!this.characterSkillNames()[name]) return;
      const players = this.game.players || [];
      const p = players.find((x) => x && (
        x.name === who || x.displayName === who ||
        (x.char && (x.char.name === who || x.char.displayName === who))
      ));
      if (p) this.skillFX(p, name);
    }

    /** 技能发动动画入口（供日志兜底与 Game.announceSkill 共用，带短时去重） */
    skillFX(player, name) {
      if (!player || !name || typeof document === 'undefined') return;
      // ★ 双保险：显式 announceSkill 入口也只播角色技能，装备技能不播横幅 / 语音。
      if (!this.characterSkillNames()[name]) return;
      const key = (player.name || '?') + '|' + name;
      const now = Date.now();
      if (this._lastSkillFX && this._lastSkillFX.key === key &&
          now - this._lastSkillFX.t < 700) return;
      this._lastSkillFX = { key: key, t: now };
      this.showSkillBanner(player, name);
      // ★ 角色技能语音：与大字同一个入口，装备技能 / 未登记技能由 Audio 层静默跳过
      try { if (SGS.Audio && SGS.Audio.playSkill) SGS.Audio.playSkill(player, name); }
      catch (e) { /* 音频失败不影响动画 */ }
    }

    /**
     * 在角色框内平滑浮出技能名大字。重复发动时清掉旧横幅并重新播放；
     * 动画结束（或 1.7s 兜底，略长于 CSS 的 1.6s 淡出）自动移除，不残留 DOM。
     * 兜底时长必须大于动画时长，否则末段淡出还没播完就被硬移除。
     */
    showSkillBanner(player, name) {
      const host = $(player && player.isHuman ? 'me-skill-banner' : 'ai-skill-banner');
      if (!host || typeof document === 'undefined') return;
      host.innerHTML = '';
      const b = document.createElement('div');
      b.className = 'skill-banner';
      b.textContent = String(name);
      host.appendChild(b);
      // 强制浏览器应用初始态，保证连续触发也能重新播放动画
      try { void b.offsetWidth; } catch (e) { /* 无布局环境忽略 */ }
      const kill = () => {
        try {
          if (b.parentNode && b.parentNode.removeChild) b.parentNode.removeChild(b);
        } catch (e) { /* 已移除 */ }
      };
      if (b.addEventListener) b.addEventListener('animationend', kill);
      if (SGS.sleep) SGS.sleep(1700).then(kill);
    }

    /**
     * 角色阵亡语音：由 Game.onDeath() 在真正阵亡（非濒死被救回）时调用。
     * 假 UI（headless 自测）没有这个方法，逻辑层会静默跳过。
     */
    playDeathVoice(player) {
      try { if (SGS.Audio && SGS.Audio.playDeath) SGS.Audio.playDeath(player); }
      catch (e) { /* 音频失败不影响结算 */ }
    }

    /* ---------------- 图片 UI：探测与加载失败回退 ---------------- */

    /**
     * 预探测 assets/ 下的角色 / 卡牌图片。
     * 只有 onload 成功才记入 this.art；onerror 什么都不做 → 保持 CSS 绘制。
     * 探测成功后重绘一次，让已经渲染的手牌 / 角色卡立即切换到图片 UI。
     * 无 DOM 环境（Node 自测）直接跳过，天然回退。
     */
    probeArt() {
      if (typeof Image === 'undefined') return;
      const self = this;
      const probe = (url, map, key) => {
        const img = new Image();
        img.onload = () => {
          map[key] = url;
          if (self.game) self.render(self.game);
          // 素材加载较慢、面板已弹出时，重绘一次让装备区 / 判定区立即切到原贴图
          if (self.pending && self.pending.mode === 'trick' &&
              typeof self.renderTargetPanel === 'function') {
            self.renderTargetPanel();
          }
          // ★【火计】查看目标手牌面板里的正面牌同样用原贴图，晚到时切过去
          if (self.pending && self.pending.mode === 'peek' &&
              typeof self.renderPeekPanel === 'function') {
            self.renderPeekPanel();
          }
          // ★ 选将界面的角色框用同一套立绘：素材晚到时重绘一次立即切到图片
          if (typeof self.renderCharPicker === 'function') self.renderCharPicker();
        };
        img.onerror = () => { /* 保持 CSS 绘制，无需处理 */ };
        img.src = url;
      };
      Object.keys(SGS.Cards.defs).forEach((type) => {
        const def = SGS.Cards.defs[type];
        if (def.image) probe('assets/cards/' + def.image, this.art.cards, type);
        // 判定区图标：assets/marks/*.png，加载成功才用图片，否则回退单字标记
        if (def.mark) probe('assets/marks/' + def.mark, this.art.marks, type);
      });
      // 通用牌背：只有加载成功才记入，失败保持 CSS 绘制的牌背
      {
        const url = 'assets/cards/back.webp';
        const img = new Image();
        img.onload = () => {
          self.art.back = url;
          // 若图片加载较慢、面板已弹出，重绘一次让牌背立刻切到图片
          if (self.pending && self.pending.mode === 'trick' &&
              typeof self.renderTargetPanel === 'function') {
            self.renderTargetPanel();
          }
        };
        img.onerror = () => { self.art.back = null; };
        img.src = url;
      }
      Object.keys(SGS.Characters).forEach((id) => {
        const file = SGS.characterImageFile(SGS.Characters[id]);
        if (file) probe('assets/characters/' + file, this.art.characters, id);
      });
    }

    /**
     * 兜底：图片已探测成功、但插入 DOM 后仍加载失败时，移除 has-art 并隐藏 img，
     * CSS 绘制立即恢复。load / error 事件不冒泡，所以用捕获阶段监听。
     */
    bindArtEvents() {
      if (typeof document.addEventListener !== 'function') return;
      const isArt = (t) => t && t.classList && (
        t.classList.contains('card-art') ||
        t.classList.contains('hero-art') ||
        t.classList.contains('pick-art') ||
        t.classList.contains('tp-art') ||   // 目标牌区面板的牌背
        t.classList.contains('mode-bg') ||  // 开局主界面氛围底图
        t.classList.contains('start-bg') || // 选将界面氛围底图
        t.classList.contains('battle-bg')   // 战斗界面氛围底图
      );
      const holderOf = (t) => closestByClass(t, 'card') ||
                              closestByClass(t, 'hero-card') ||
                              closestByClass(t, 'avatar') ||
                              closestByClass(t, 'tp-card') ||
                              closestByClass(t, 'mode-bg-wrap') ||
                              closestByClass(t, 'start-bg-wrap') ||
                              closestByClass(t, 'battle-bg-wrap');
      document.addEventListener('load', (e) => {
        const t = e.target;
        if (!isArt(t)) return;
        const holder = holderOf(t);
        if (holder) holder.classList.add('has-art');
      }, true);
      document.addEventListener('error', (e) => {
        const t = e.target;
        if (!isArt(t)) return;
        t.style.display = 'none';
        const holder = holderOf(t);
        // 移除 has-art → CSS 牌背 / ✦ 纹章恢复（tp-emblem 一直在 DOM 里）
        if (holder) holder.classList.remove('has-art');
        // 战斗底图插入后才报错：同步撤掉 #app 的类，恢复原来的 CSS 远山 / 水纹
        if (t.classList && t.classList.contains('battle-bg')) {
          const app = $('app');
          if (app && app.classList) app.classList.remove('battle-art-on');
        }
      }, true);
    }

    bindGame(game) {
      this.game = game;
    }

    /* ---------------- 开局选将 ---------------- */

    /* ---------------- 开局主界面（模式选择） ---------------- */

    /**
     * 通用氛围底图探测：只有 onload 成功才给 wrap 加 .has-art 并显示 <img>，
     * 失败 / 文件缺失 / 无 DOM 环境一律保持纯 CSS 水墨远山回退态。
     * 图片已插入后若仍触发 DOM 级 error，由 bindArtEvents() 移除 has-art。
     * ★ 背景只做氛围，所有 UI 由 DOM 绘制 → 与图片尺寸完全解耦。
     */
    probeBackground(wrapId, imgId, url, onDone) {
      const wrap = $(wrapId);
      const img = $(imgId);
      if (!wrap || !img || typeof Image === 'undefined') {
        if (onDone) onDone(false);
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        img.src = url;                    // 同源缓存命中，几乎无空白闪
        if (wrap.classList) wrap.classList.add('has-art');
        if (onDone) onDone(true);
      };
      probe.onerror = () => {
        if (wrap.classList) wrap.classList.remove('has-art');
        if (onDone) onDone(false);
      };
      probe.src = url;
    }

    /** 三张氛围底图：主界面 1 / 选将界面 2 / 战斗界面 3。
     *  战斗底图额外给 #app 打 .battle-art-on，用来隐藏原 CSS 远山 / 水纹，
     *  避免纹理叠在照片上发脏；加载失败则保持原来的纯 CSS 远景。 */
    probeStartBackground() {
      this.probeBackground('mode-bg-wrap', 'mode-bg',
        'assets/backgrounds/background1.webp');
      this.probeBackground('start-bg-wrap', 'start-bg',
        'assets/backgrounds/background2.webp');
      this.probeBackground('battle-bg-wrap', 'battle-bg',
        'assets/backgrounds/background3.webp', (ok) => {
          const app = $('app');
          if (!app || !app.classList) return;
          if (ok) app.classList.add('battle-art-on');
          else app.classList.remove('battle-art-on');
        });
    }

    /** 「暂未开放」轻提示：1.9 秒后自动淡出，连点重置计时 */
    showModeToast(msg) {
      const t = $('mode-toast');
      if (!t) return;
      t.textContent = String(msg);
      if (t.classList) t.classList.add('show');
      if (typeof clearTimeout === 'function') clearTimeout(this._modeToastTimer);
      const hide = () => { if (t.classList) t.classList.remove('show'); };
      if (typeof setTimeout === 'function') {
        this._modeToastTimer = setTimeout(hide, 1900);
      } else { hide(); }
    }

    /**
     * 显示开局主界面并绑定四张卡片。
     *   · 1v1               → 淡出主界面，回调 onEnter('1v1') 进入选将流程
     *   · 2v2 / 斗地主 / 军争 → 只弹「暂未开放」，界面不动、不创建对局
     * 无该界面（自测 / 极简 DOM）时直接放行 1v1，保证游戏仍可启动。
     */
    showModeScreen(onEnter) {
      const screen = $('mode-screen');
      if (!screen) { if (onEnter) onEnter('1v1'); return; }
      this.probeStartBackground();
      const btns = (typeof screen.querySelectorAll === 'function')
        ? screen.querySelectorAll('.mode-item') : [];
      Array.prototype.forEach.call(btns, (btn) => {
        if (!btn || typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', () => {
          const mode = (btn.dataset && btn.dataset.mode) || '';
          if (mode !== '1v1') {
            this.showModeToast('【' + (MODE_LABELS[mode] || '该模式') +
              '】暂未开放，敬请期待');
            return;
          }
          if (screen.classList) screen.classList.add('leaving');
          if (onEnter) onEnter(mode);
          const hide = () => { if (screen.classList) screen.classList.add('hidden'); };
          if (typeof setTimeout === 'function') setTimeout(hide, 300);
          else hide();
        });
      });
    }

    /**
     * 选将界面：横排展示【与局内完全同款】的角色框，框下方一枚选择按钮。
     *   · 角色框复用 .hero-card 一整套 DOM / CSS：立绘、势力纯文字、竖排名字、
     *     体力圆点 + x/y、角色信息浮层（技能逐条换行）。
     *   · hover 或点击角色框 → 显示 / 固定角色信息（和局内交互一致）。
     *   · 点「选择此将」按钮 → 隐藏选将层并回调 onPick(角色 id)。
     * 立绘探测结果晚到时由 probeArt() 调 renderCharPicker() 重绘一次。
     */
    showStartScreen(onPick) {
      const sc = $('start-screen');
      if (sc && sc.classList) sc.classList.remove('hidden');
      this._pickChars = Object.keys(SGS.Characters)
        .map((k) => SGS.Characters[k]);
      this._pickOnPick = onPick;
      // 势力筛选 / 搜索状态：过滤只重建 #char-picker，工具栏 DOM 不动，
      // 因此输入过程中输入框不会失焦，光标与已输入内容都保留。
      this._pickFaction = '全';
      this._pickQuery = '';
      this._pickRendered = false;
      this.bindPickTools();
      // 重复进入选将界面时，工具栏也同步回到「全」+ 空搜索
      const input0 = $('pick-search');
      const wrap0 = $('pick-search-wrap');
      if (input0) input0.value = '';
      if (wrap0 && wrap0.classList) wrap0.classList.remove('has-query');
      const bar0 = $('pick-factions');
      const btns0 = (bar0 && typeof bar0.querySelectorAll === 'function')
        ? bar0.querySelectorAll('.pf-btn') : [];
      Array.prototype.forEach.call(btns0, (b) => {
        if (b && b.classList) {
          b.classList.toggle('active', !!(b.dataset && b.dataset.faction === '全'));
        }
      });
      this.renderCharPicker();
    }

    /** 绑定势力按钮 / 搜索框 / 清空按钮（工具栏是静态 DOM，只绑一次） */
    bindPickTools() {
      if (this._pickToolsBound) return;
      const self = this;
      const bar = $('pick-factions');
      const input = $('pick-search');
      const clear = $('pick-search-clear');
      const wrap = $('pick-search-wrap');
      const btns = (bar && typeof bar.querySelectorAll === 'function')
        ? bar.querySelectorAll('.pf-btn') : [];

      Array.prototype.forEach.call(btns, (btn) => {
        if (!btn || typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', () => {
          const f = (btn.dataset && btn.dataset.faction) || '全';
          self._pickFaction = f;
          Array.prototype.forEach.call(btns, (b) => {
            if (b && b.classList) b.classList.remove('active');
          });
          if (btn.classList) btn.classList.add('active');
          self.renderCharPicker();
        });
      });

      if (input && typeof input.addEventListener === 'function') {
        input.addEventListener('input', () => {
          self._pickQuery = String(input.value || '');
          if (wrap && wrap.classList) {
            if (self._pickQuery.trim()) wrap.classList.add('has-query');
            else wrap.classList.remove('has-query');
          }
          self.renderCharPicker();
        });
      }
      if (clear && typeof clear.addEventListener === 'function') {
        clear.addEventListener('click', () => {
          self._pickQuery = '';
          if (input) input.value = '';
          if (wrap && wrap.classList) wrap.classList.remove('has-query');
          self.renderCharPicker();
          if (input && typeof input.focus === 'function') input.focus();
        });
      }
      this._pickToolsBound = true;
    }

    /** 清空筛选与搜索，恢复「全」 */
    resetPickFilter() {
      this._pickFaction = '全';
      this._pickQuery = '';
      const input = $('pick-search');
      const wrap = $('pick-search-wrap');
      if (input) input.value = '';
      if (wrap && wrap.classList) wrap.classList.remove('has-query');
      const bar = $('pick-factions');
      const btns = (bar && typeof bar.querySelectorAll === 'function')
        ? bar.querySelectorAll('.pf-btn') : [];
      Array.prototype.forEach.call(btns, (b) => {
        if (!b || !b.classList) return;
        const isAll = !!(b.dataset && b.dataset.faction === '全');
        b.classList.toggle('active', isAll);
      });
      this.renderCharPicker();
    }

    /** 当前筛选条件下可见的角色 */
    filteredPickChars() {
      const faction = this._pickFaction || '全';
      const q = String(this._pickQuery || '').trim().toLowerCase();
      return (this._pickChars || []).filter((c) => {
        if (faction !== '全' && (c.faction || '群') !== faction) return false;
        if (!q) return true;
        const skills = c.skills || (c.skill ? [c.skill] : []);
        // 可搜：显示名 / 完整名 / 介绍名 / 称号 / 势力 / 技能名与描述
        const hay = [
          displayNameOf(c), c.name, c.introName, c.title, c.avatar, c.faction
        ].concat(skills.map((sk) =>
          [sk.name, sk.titles, sk.desc].filter(Boolean).join(' ')))
          .filter(Boolean).join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }

    /** 生成 / 重绘选将角色框（过滤、图片晚到时重入；重建 DOM 后重新绑定事件） */
    renderCharPicker() {
      if (!this._pickChars || typeof document === 'undefined') return;
      const box = $('char-picker');
      if (!box) return;
      const sc = $('start-screen');
      // 选将层已隐藏（已开局）时不重绘，避免无谓重建
      if (sc && sc.classList && sc.classList.contains('hidden') &&
          this._pickRendered) return;
      const self = this;
      const chars = this.filteredPickChars();

      // 无匹配：给一个美观的空态，并留一键恢复，不让界面变成一片空白
      if (!chars.length) {
        if (sc && sc.classList) sc.classList.add('pick-is-empty');
        const faction = this._pickFaction || '全';
        const q = String(this._pickQuery || '').trim();
        const cond = [
          faction !== '全' ? '势力「' + faction + '」' : '',
          q ? '关键词「' + q + '」' : ''
        ].filter(Boolean).join(' · ');
        box.innerHTML = '<div class="pick-empty">' +
          '<div class="pick-empty-mark">✦</div>' +
          '<div class="pick-empty-title">暂无符合条件的武将</div>' +
          '<div class="pick-empty-sub">' + escText(cond || '换个条件试试') +
            ' &nbsp;·&nbsp; 后续版本会陆续加入更多角色</div>' +
          '<button class="pick-reset" data-id="__reset__" type="button">' +
            '显示全部武将 <em>→</em></button>' +
        '</div>';
        this._pickRendered = true;
        const resets = (typeof box.querySelectorAll === 'function')
          ? box.querySelectorAll('.pick-reset') : [];
        Array.prototype.forEach.call(resets, (btn) => {
          if (btn && typeof btn.addEventListener === 'function') {
            btn.addEventListener('click', () => self.resetPickFilter());
          }
        });
        return;
      }

      if (sc && sc.classList) sc.classList.remove('pick-is-empty');
      box.innerHTML = chars.map((c) => {
        const artUrl = this.art.characters[c.id] || '';
        const shown = displayNameOf(c);
        const len = Math.max(1, shown.length);
        const faction = c.faction || '群';
        // 伪 player：满体力 / 空手牌，供 hpHTML 与 heroInfoHTML 复用局内渲染
        const pseudo = { char: c, name: c.name, hp: c.maxHp,
                         maxHp: c.maxHp, hand: [] };
        return '<div class="pick-slot" data-id="' + escText(c.id) + '">' +
          '<div class="hero-card pick-hero' + (artUrl ? ' has-art' : '') + '"' +
            ' data-id="' + escText(c.id) + '"' +
            ' style="--name-scale:' + (1 / len).toFixed(4) +
            ';--hp-pips:' + Math.max(1, c.maxHp || 1) + '">' +
            (artUrl ? '<img class="hero-art" src="' + escText(artUrl) + '" alt="">' : '') +
            '<div class="hero-faction" data-faction="' + escText(faction) + '">' +
              escText(faction) + '</div>' +
            '<div class="hero-name">' + escText(shown) + '</div>' +
            '<div class="hero-hp">' + this.hpHTML(pseudo) + '</div>' +
            '<div class="hero-info">' +
              this.heroInfoHTML(pseudo, { noHand: true }) + '</div>' +
          '</div>' +
          '<button class="pick-btn" data-id="' + escText(c.id) + '" type="button">' +
            '选择此将 <em>→</em></button>' +
        '</div>';
      }).join('');
      this._pickRendered = true;

      const heroes = (typeof box.querySelectorAll === 'function')
        ? box.querySelectorAll('.pick-hero') : [];
      Array.prototype.forEach.call(heroes, (hero) => {
        if (!hero || typeof hero.addEventListener !== 'function') return;
        hero.addEventListener('click', () => {
          const wasOpen = hero.classList && hero.classList.contains('info-open');
          Array.prototype.forEach.call(heroes, (h) => {
            if (h && h.classList) h.classList.remove('info-open');
          });
          if (!wasOpen && hero.classList) hero.classList.add('info-open');
        });
      });
      const btns = (typeof box.querySelectorAll === 'function')
        ? box.querySelectorAll('.pick-btn') : [];
      Array.prototype.forEach.call(btns, (btn) => {
        if (!btn || typeof btn.addEventListener !== 'function') return;
        btn.addEventListener('click', (e) => {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
          const sc2 = $('start-screen');
          if (sc2 && sc2.classList) sc2.classList.add('hidden');
          // ★ 联机：把当前联机会话一起交给启动回调；本地对战时为 null
          if (self._pickOnPick) self._pickOnPick(btn.dataset.id, self._pickNetInfo || null);
        });
      });
    }

    /* ---------------- 渲染 ---------------- */

    /**
     * 主循环仍会广播阶段变化，但界面不再展示当前阶段（六阶段流程照常执行）。
     * 保留空实现，避免改动 game.js 的调用契约。
     */
    setPhase() {}

    setHint(text) {
      $('hint').textContent = text || '';
    }

    hpHTML(p) {
      const hp = Math.max(0, Math.min(p.hp, p.maxHp));
      const max = Math.max(1, p.maxHp || 1);
      // ★ 体力圆点颜色按「当前体力 / 上限」比例三档：
      //     > 2/3 绿 | 1/3 < r <= 2/3 橙 | <= 1/3 红
      //   用整数乘法比较（hp*3 与 max*2 / max），避开 2/3、1/3 的浮点误差。
      const tone = (hp * 3 > max * 2) ? 'green'
        : (hp * 3 > max ? 'orange' : 'red');
      let s = '<span class="hp-num">' + hp + '/' + p.maxHp + '</span>';
      // .hero-hp 为 flex-direction:column，i=0 在最上方。
      // 底部 hp 个点亮 → 掉血时最上方的点先熄灭，扣除方向自上而下。
      const firstOn = p.maxHp - hp;
      for (let i = 0; i < p.maxHp; i++) {
        s += '<i class="pip ' + (i >= firstOn ? 'on ' + tone : 'off') + '"></i>';
      }
      return s;
    }

    cardHTML(c, opts) {
      opts = opts || {};
      // ★ 兜底：任何「牌背」占位对象都走 cardBackHTML()（优先 back.webp 贴图），
      //   绝不落到「按 type 找卡面贴图」的分支 —— 那样会画出一张无图、
      //   只有 CSS 底纹和「牌背」两个字的空卡。飞牌 / 展示区 / 面板共用。
      if (c && c.type === 'back') return this.cardBackHTML();
      // 只有预探测成功的图片才输出 <img>；素材缺失 / 加载错误时
      // 完全不插入图片节点，CSS 绘制的卡面（牌名、点数、花色）照常显示。
      const artUrl = this.art.cards[c.type];
      // ★ 丈八蛇矛「一红一黑」转化出的无色杀用中性色，避免被误画成黑杀；
      //   其余没有 color 字段的牌保持原来的黑色（向后兼容）。
      const colorCls = c.color === 'red' ? 'red'
        : (c.color === 'black' ? 'black' : (c.zhangba ? 'colorless' : 'black'));
      const cls = [
        'card',
        colorCls,
        SGS.Cards.isTrick(c.type) ? 'trick' : '',  // 锦囊牌仅四字牌名用小字号，卡面与基本牌同色
        SGS.Cards.isEquip(c.type) ? 'equip' : '', // 装备牌同色同底，长牌名同样用小字号
        opts.selected ? 'sel' : '',
        opts.justPicked ? 'picked' : '',  // 所有选牌模式共用的「刚选中」上浮动画
        opts.dim ? 'dim' : '',
        artUrl ? 'has-art' : ''
      ].filter(Boolean).join(' ');
      return (
        '<div class="' + cls + '"' + (c.id && !opts.noId ? ' data-id="' + c.id + '"' : '') + '>' +
        (artUrl ? '<img class="card-art" src="' + artUrl + '" alt="">' : '') +
        '<span class="corner"><span>' + (c.rank || '') + '</span><span>' + (c.suit || '') + '</span></span>' +
        '<span class="cname">' + c.name + '</span>' +
        '</div>'
      );
    }

    /**
     * 背面朝上的卡牌（AI 摸牌 / AI 获得暗手牌 / 目标牌区面板的手牌格用）。
     * ★ 玩家自己摸牌与玩家顺手牵羊获得牌已改为「正面插入手牌区」，不再走这里。
     * 优先 assets/cards/back.webp；探测失败 / DOM 加载失败时回退到 CSS 绘制的牌背
     * （与「目标牌区面板」里那套金色牌背视觉一致）。
     */
    cardBackHTML() {
      const back = this.art.back;
      const cls = 'card card-back' + (back ? ' has-art' : '');
      return '<div class="' + cls + '">' +
        (back ? '<img class="card-art" src="' + back + '" alt="">' : '<span class="back-emblem">✦</span>') +
        '</div>';
    }

    /**
     * 「接在手牌区最右边那张牌右边」的落点 x（第一张新牌的 left）。
     *
     * 摸牌动画与顺手牵羊共用本方法，保证两种来源的新牌都落在同一个位置：
     * 取 #me-hand 里最后一张真实手牌的右边缘，再加一个手牌间距。
     * 动画期间新牌还没进 hand / 还没 render，所以量到的正是「旧手牌末尾」。
     * 没有手牌或无法量取时回退到手牌区居中；间距优先读 .hand 的 column-gap。
     */
    handAppendX(cardW, handRect) {
      let lastRight = null;
      const rectOf = (el) => el && typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect() : null;
      try {
        if (typeof document.querySelectorAll === 'function') {
          const list = document.querySelectorAll('#me-hand .card');
          if (list && list.length) {
            const r = rectOf(list[list.length - 1]);
            if (r && r.width) lastRight = r.left + r.width;
          }
        }
        // 兜底：某些环境只实现了 querySelector
        if (lastRight === null && typeof document.querySelector === 'function') {
          const one = document.querySelector('#me-hand .card:last-child') ||
                      document.querySelector('#me-hand .card');
          const r = rectOf(one);
          if (r && r.width) lastRight = r.left + r.width;
        }
      } catch (e) { /* 无 DOM 环境 → 走回退 */ }

      if (lastRight === null) {
        return handRect.left + (handRect.width - cardW) / 2;  // 暂无手牌 → 居中
      }
      let gap = 6;
      try {
        if (typeof getComputedStyle === 'function') {
          const cs = getComputedStyle($('me-hand'));
          const g = parseFloat(cs && (cs.columnGap || cs.gap));
          if (g > 0) gap = g;
        }
      } catch (e) { /* 用默认间距 */ }
      // ★ 手牌 >8 张时进入叠放，新牌落点要按实际「相邻两张的左边缘间距」
      //   接在末尾，否则会飞到手牌区外再瞬间跳回。
      try {
        const handEl = $('me-hand');
        if (handEl && handEl.classList.contains('stacked') &&
            typeof document.querySelectorAll === 'function') {
          const list = document.querySelectorAll('#me-hand .card');
          if (list && list.length >= 2) {
            const prev = rectOf(list[list.length - 2]);
            const last = rectOf(list[list.length - 1]);
            if (prev && last && last.left > prev.left) return lastRight + (last.left - prev.left);
          }
        }
      } catch (e) { /* 回退到普通间距 */ }
      return lastRight + gap;
    }

    /**
     * ★ 手牌超过 8 张时，按手牌区实际宽度自动计算叠放间距：
     *   卡牌保持原始尺寸，用负 margin 相互遮盖，保证整叠手牌始终落在
     *   手牌区内（不同屏幕 / 缩放比例都自适应）。<=8 张时完全不叠放。
     */
    layoutHand(count) {
      const handEl = $('me-hand');
      if (!handEl) return;
      handEl.style.setProperty('--hand-overlap', '0px');
      handEl.classList.toggle('stacked', count > 8);
      if (!count || count <= 8 || typeof document.createElement !== 'function') return;

      // 用隐藏探针量取卡牌「未收缩」时的自然宽度（不受 flex 压缩影响）
      const probe = document.createElement('div');
      probe.className = 'card';
      probe.style.cssText =
        'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;flex:none;';
      handEl.appendChild(probe);
      const cardW = probe.getBoundingClientRect().width || 0;
      probe.remove();
      let gap = 0;
      try {
        if (typeof getComputedStyle === 'function') {
          gap = parseFloat(getComputedStyle(handEl).columnGap) || 0;
        }
      } catch (e) { /* 无样式环境按 0 处理 */ }
      const avail = handEl.clientWidth || handEl.getBoundingClientRect().width || 0;
      if (!cardW || !avail || count < 2) return;

      const step = (avail - cardW) / (count - 1);
      const overlap = Math.min(0, Math.floor(step - cardW - gap));
      handEl.style.setProperty('--hand-overlap', overlap + 'px');
    }

    /* ---------------- 手牌自动 FLIP（render 内置） ---------------- */

    /**
     * ★「离手」预测整理：出牌 / 弃牌 / 使用装备时，手牌区【立刻】按
     *   「这张牌已经离开」重排，让手牌合拢与飞牌同一帧开始。
     *
     * 关键点（这里踩过坑，改动前务必读完）：
     *   · 真牌必须【真的从 DOM 里摘掉】，不能只 visibility:hidden。
     *     隐藏只影响绘制、仍占布局位：量出来的「移除后」坐标其实用不上，
     *     等 FLIP 的 transform 回到 0，留下来那些牌又会被 flex 排回原位 ——
     *     表现就是「手牌先挤过去、飞牌快落地时又散开、落地再挤一次」。
     *   · 摘掉后调用 layoutHand()，让 #me-hand 真正按「少一张」布局，
     *     再用 FLIP 把留下来的牌从旧位置平滑过渡到新位置。
     *   · 摘掉的牌 id 记进 this._departing，render / syncHandDOM 会把它当作
     *     「已经不在手里」，直到权威手牌数据里真的没有它（见 visibleHand）。
     *     否则快照 / ask 触发的重绘会把这半秒内还在状态里的牌重新塞回手牌区，
     *     就是「牌已经飞走、原位又闪一下原牌」。
     *
     * @returns {boolean} true = 已从手牌区摘掉并开始合拢动画
     */
    predictHandDeparture(cardEl) {
      const handEl = $('me-hand');
      if (!handEl || !cardEl || typeof document.querySelectorAll !== 'function') return false;
      const list = () => {
        try { return Array.prototype.slice.call(
          document.querySelectorAll('#me-hand .card')); } catch (e) { return []; }
      };
      const all = list();
      if (all.indexOf(cardEl) < 0) return false;
      const idOf = (el) => el && el.dataset && el.dataset.id != null
        ? String(el.dataset.id) : '';
      // ① FIRST：先记下留下来的每张牌当前位置（不含正在离场的那张）
      const before = {};
      all.forEach((el) => {
        if (el === cardEl) return;
        const id = idOf(el);
        const r = el && typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect() : null;
        if (id && r && r.width) before[id] = { left: r.left, top: r.top };
      });
      // ② 真离手：摘节点（摘成功才登记 id）+ 重排
      if (cardEl.parentNode && cardEl.parentNode.removeChild) {
        cardEl.parentNode.removeChild(cardEl);
      } else if (typeof handEl.removeChild === 'function') {
        handEl.removeChild(cardEl);
      } else {
        return false;
      }
      const goneId = idOf(cardEl);
      if (goneId) this._departing[goneId] = Date.now();
      this.layoutHand(all.length - 1);
      // ③ LAST + INVERT：留下来的牌先拉回旧位置，下一帧过渡到新位置
      const movers = [];
      list().forEach((el) => {
        const id = idOf(el);
        const b = id && before[id];
        if (!b) return;
        const r = el && typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect() : null;
        if (!r || !r.width) return;
        const dx = b.left - r.left, dy = b.top - r.top;
        if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        if (el.classList) el.classList.add('flip-move');
        movers.push(el);
      });
      if (movers.length) {
        const play = () => movers.forEach((el) => {
          el.style.transition = 'transform .42s cubic-bezier(.22,.61,.36,1)';
          el.style.transform = 'translate(0,0)';
        });
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(play));
        } else play();
        this._predictMovers = (this._predictMovers || []).concat(movers);
      }
      return true;
    }

    /**
     * 手牌里「还在手上」的那些牌：把 _departing 里已经离场的牌滤掉。
     *
     * 何时清除 _departing：
     *   · 权威手牌数据已经不含这个 id → 离手完成（正常路径，下一次 render 就清）
     *   · 超过 1.6s 仍在手牌里    → 兜底（例如某次飞牌后被回滚），恢复显示
     * 这样「牌已飞走但状态还没更新」的窗口内，任何一次重绘都不会把它塞回来。
     */
    visibleHand(hand) {
      const map = this._departing || {};
      const arr = hand || [];
      const ids = {};
      arr.forEach((c) => { if (c && c.id != null) ids[String(c.id)] = true; });
      const now = Date.now();
      Object.keys(map).forEach((k) => {
        if (!ids[k]) delete map[k];
        else if (now - map[k] > 1600) delete map[k];
      });
      const keys = Object.keys(map);
      if (!keys.length) return arr;
      return arr.filter((c) => !(c && c.id != null && map[String(c.id)]));
    }

    /** 手牌真正重排后清掉预测残留的 inline 样式 */
    clearPredictMovers() {
      const list = this._predictMovers || [];
      this._predictMovers = [];
      list.forEach((el) => {
        try {
          el.style.transition = '';
          el.style.transform = '';
          if (el.classList) el.classList.remove('flip-move');
        } catch (e) { /* 节点已移除 */ }
      });
    }

    /**
     * FIRST：在 #me-hand 被 innerHTML 重建之前，记录每张旧手牌的屏幕位置。
     * 按 data-id 索引，返回 null 表示无可量布局（无 DOM 环境 / 空手牌）。
     */
    captureHandRects() {
      const handEl = $('me-hand');
      if (!handEl || typeof document === 'undefined') return null;
      const map = {};
      try {
        let list = null;
        if (typeof document.querySelectorAll === 'function') {
          list = document.querySelectorAll('#me-hand .card');
        } else if (handEl.children) {
          list = Array.prototype.filter.call(handEl.children, (el) =>
            el.classList && el.classList.contains('card'));
        }
        if (!list) return null;
        Array.prototype.forEach.call(list, (el) => {
          const id = el.dataset && el.dataset.id;
          if (!id || typeof el.getBoundingClientRect !== 'function') return;
          const r = el.getBoundingClientRect();
          if (!r || !r.width) return;
          let top = r.top;
          // ★ 带 sel / picked 的牌正在上浮，getBoundingClientRect 拿到的是
          //   transform 后的坐标；若恰逢 card-pick 动画播放到中间帧，这个
          //   top 会飘，减选 / 取消时 FLIP 起点就不准，看起来像「跳一下」。
          //   这里换算成「稳定的上浮位置」= 逻辑位置 − --sel-lift：
          //     逻辑位置 = r.top − 当前 transform 的 translateY
          //   于是无论动画播到哪一帧，减选的牌都从同一个高度平滑落下。
          if (el.classList && (el.classList.contains('sel') ||
              el.classList.contains('picked')) &&
              typeof getComputedStyle === 'function') {
            try {
              const cs = getComputedStyle(el);
              const lift = parseFloat(cs.getPropertyValue('--sel-lift')) || 0;
              const parent = el.offsetParent;
              // offsetTop 是布局值，不受 transform / 动画影响；换算回视口坐标
              // 再减去稳定的上浮量，得到「牌选中时应该在的位置」。
              // 无布局环境（Node 自测桩）保持 r.top，旧行为不变。
              if (parent && typeof parent.getBoundingClientRect === 'function' &&
                  typeof el.offsetTop === 'number') {
                top = parent.getBoundingClientRect().top + el.offsetTop - lift;
              }
            } catch (e) { /* 无布局环境保持 r.top */ }
          }
          map[String(id)] = { left: r.left, top: top };
        });
      } catch (e) { return null; }
      return Object.keys(map).length ? map : null;
    }

    /**
     * LAST + INVERT + PLAY：render() 重建手牌后调用。
     * 对「仍留在手里、但位置变了」的旧牌，先用 inline transform 拉回旧位置，
     * 下一帧再过渡回 0 —— 出牌、弃牌、装备、被牵、被拆之后手牌平滑合拢，
     * 不再瞬间跳位。新出现的牌不参与（它们由各自的飞入动画负责）。
     * 纯视觉：发射后不 await，动画结束自动清理 inline 样式。
     */
    playHandFlip(before) {
      if (!before || typeof document === 'undefined' ||
          typeof document.querySelectorAll !== 'function') return;
      const gen = ++this._handFlipGen;
      const movers = [];
      try {
        const list = document.querySelectorAll('#me-hand .card');
        Array.prototype.forEach.call(list, (el) => {
          const id = el.dataset && el.dataset.id;
          const f = id && before[String(id)];
          if (!f || typeof el.getBoundingClientRect !== 'function') return;
          const r = el.getBoundingClientRect();
          if (!r || !r.width) return;
          // ★ 仍带选中态的牌不参与 FLIP：它们的 transform 由 .sel / .picked
          //   控制（静态上浮 + 刚选中动画）。多选选牌时手牌数量没变，本就
          //   不需要合拢；而 getBoundingClientRect 会把 .picked 动画/scale 的
          //   那几像素也算进去，dy 非 0 → 旧逻辑给它设 inline transform 覆盖
          //   上浮，等 cleanup 清掉 inline 又突然弹回选中位置，看起来就是
          //   「点下一张时上一张先落下、再弹起来」。这里直接跳过：
          //     · 已选中的牌（sel/picked）→ 保持静态上浮，不抖动
          //     · 本次新选中的牌（未选→已选）→ 交给 card-pick 动画
          //     · 减选的牌（已选→未选）→ 不带选中态，仍走 FLIP 平滑落下
          if (el.classList && (el.classList.contains('sel') ||
              el.classList.contains('picked'))) return;
          const dx = f.left - r.left, dy = f.top - r.top;
          if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
          el.style.transition = 'none';
          el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          if (el.classList) el.classList.add('flip-move');
          movers.push(el);
        });
      } catch (e) { return; }
      if (!movers.length) return;
      const play = () => {
        movers.forEach((el) => {
          el.style.transition = 'transform .42s cubic-bezier(.22,.61,.36,1)';
          el.style.transform = 'translate(0,0)';
        });
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(play));
      } else { play(); }
      const cleanup = () => {
        if (gen !== this._handFlipGen) return;   // 已有更新的 FLIP 在跑
        movers.forEach((el) => {
          el.style.transition = '';
          el.style.transform = '';
          if (el.classList) el.classList.remove('flip-move');
        });
      };
      if (SGS && SGS.sleep) SGS.sleep(470).then(cleanup);
      else if (typeof setTimeout === 'function') setTimeout(cleanup, 470);
    }

    /**
     * 装备栏内一行装备信息：花色 + 点数 + 名称 + 说明。
     * 不用图标（按需求），纯文字；武器写攻击范围、坐骑写加减距离，防具留空。
     * mini=true 是「其他角色角色框内的缩小版」，说明用简称（攻1 / 距+1 / 距-1）。
     */
    equipInfoHTML(c, mini) {
      const corner = (c.rank || '') + (c.suit || '');
      const note = SGS.Equipment.noteOf(c, mini);
      return '<span class="eq-corner ' + (c.color === 'red' ? 'red' : 'black') + '">' + corner + '</span>' +
        '<span class="eq-name" title="' + c.name + '">' + c.name + '</span>' +
        (note ? '<span class="eq-note" title="' + note + '">' + note + '</span>' : '');
    }

    /** 渲染玩家装备区（手牌区左侧四横栏）与其他角色框内的迷你装备栏 */
    renderEquips(game) {
      const me = game.human;
      const ai = game.aiPlayer;

      const mine = $('me-equip-area');
      if (mine) {
        // ★【丈八蛇矛】主动转化：只有「玩家本人正在出牌 / 被索要【杀】」时，
        //   武器栏才可点，加 .zhangba-ready 高亮；其余装备栏保持纯展示。
        const pd = this.pending;
        const zhangbaReady = !!pd && pd.player === me &&
          (pd.mode === 'play' || (pd.mode === 'respond' && pd.respondNeed === 'sha')) &&
          SGS.Equipment && SGS.Equipment.hasZhangba(me) &&
          me.hand.length >= 2 &&
          (pd.mode !== 'play' || me.canPlaySha());
        // ★ 贯石斧等「手牌 + 装备区」多选：装备栏也可点，已选的同样上浮高亮
        const pickEquip = !!pd && pd.mode === 'pick' && pd.player === me && pd.allowEquip;
        // ★「牌」= 手牌 + 装备区：技能选牌模式下，能参与本次转化的装备牌
        //   也高亮可点，与贯石斧的选择器一致（不含判定区）。
        const skillEquip = !!pd && pd.mode === 'skill' && pd.player === me;
        const equipSelected = pickEquip && Array.isArray(pd.equipSelected)
          ? pd.equipSelected : [];
        mine.innerHTML = SGS.EQUIP_SLOTS.map((s) => {
          const c = me.equips && me.equips[s.key];
          const inPick = pickEquip && !!c && equipSelected.indexOf(c.id) >= 0;
          const skillConv = skillEquip && c
            ? findConversion(me, c, pd.scene, pd.respondNeed, pd.skillName) : null;
          const skillPicked = !!skillEquip && !!c && !!pd.card &&
            pd.card.id === c.id;
          const canClick = s.key === 'weapon' && zhangbaReady &&
            c && SGS.Equipment.weaponFlag(me, 'zhangba');
          return '<div class="equip-slot' + (c ? ' equipped' : '') +
            (canClick ? ' zhangba-ready' : '') +
            (skillConv ? ' skill-ready' : '') +
            ((canClick || (pickEquip && c) || skillConv) ? ' clickable' : '') +
            ((inPick || skillPicked) ? ' selected' : '') + '"' +
            ' id="me-equip-' + s.key + '" data-slot="' + s.key + '"' +
            (c ? ' data-card-id="' + c.id + '"' : '') + '>' +
            '<span class="eq-label">' + s.label + '</span>' +
            (c ? this.equipInfoHTML(c, false) : '<span class="eq-empty">' + s.empty + '</span>') +
            (canClick ? '<span class="eq-hint">点此发动</span>' : '') +
            (pickEquip && c ? '<span class="eq-hint">' +
              (inPick ? '已选' : '点此选择') + '</span>' : '') +
            (skillConv ? '<span class="eq-hint">' +
              (skillPicked ? '已选' : '点此转化') + '</span>' : '') +
            '</div>';
        }).join('');
      }

      // 其他角色：只列出已装备的槽（没装就不显示），全空时整块隐藏
      const box = $('ai-equips');
      if (box) {
        const rows = SGS.EQUIP_SLOTS.filter((s) => ai.equips && ai.equips[s.key]);
        box.innerHTML = rows.map((s) =>
          '<div class="eq-mini-row" data-slot="' + s.key + '">' +
          this.equipInfoHTML(ai.equips[s.key], true) + '</div>'
        ).join('');
        if (box.classList) box.classList.toggle('hidden', rows.length === 0);
      }
      const aiCard = $('ai-area');
      if (aiCard && aiCard.classList) {
        aiCard.classList.toggle('has-equips', SGS.Equipment.count(ai) > 0);
      }
    }

    /**
     * 判定区图标：延时锦囊牌用 assets/marks/*.png 显示，图片未探测成功时
     * 回退到单字标记（乐 / 兵 / 闪）。title 始终写完整牌名，方便辨认。
     */
    judgeMarkHTML(player) {
      return ((player && player.delayed) || []).map((c) => {
        const def = SGS.Cards.defs[c.type] || {};
        const name = c.name || SGS.Cards.nameOf(c.type);
        const url = this.art.marks[c.type];
        if (url) {
          return '<span class="judge-mark" title="判定区：' + name + '">' +
            '<img src="' + url + '" alt="' + name + '"></span>';
        }
        return '<span class="judge-mark fallback" title="判定区：' + name + '">' +
          (def.markShort || name.slice(0, 1)) + '</span>';
      }).join('');
    }

    /**
     * 角色信息浮层：鼠标悬停或点击角色框时显示。
     * ★ 技能之间要换行：每个技能单独一块（技能名一行、描述一行）；
     *   单段描述里若用「｜」并列多个技能（如【神】赵云 绝境 / 龙魂），
     *   也按分隔符拆开逐块渲染，保证双技能清晰分行。
     */
    heroInfoHTML(p, opts) {
      const ch = p.char || {};
      // 选将界面还没发手牌，传 { noHand:true } 省掉「手牌 0」；局内保持原样
      const noHand = !!(opts && opts.noHand);
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const block = (name, desc) =>
        '<div class="hi-skill"><div class="hi-sname">' + esc(name) + '</div>' +
        '<div class="hi-sdesc">' + esc(desc) + '</div></div>';
      // ★ 局内读玩家当前技能视图：涅槃后新获得的技能立即出现在角色信息里；
      //   选将界面传的伪 player 没有 skill，仍读 char.skill（含 ☆ 备选说明）
      const currentSkill = p.skill || ch.skill;
      const list = ch.skills || (currentSkill ? [currentSkill] : []);
      const body = list.map((s) => {
        const parts = String(s.desc || '').split(/\s*[｜|]\s*/)
          .map((x) => x.trim()).filter(Boolean)
          // ★ 局内只展示已拥有的技能：选将卡保留 ☆ 备选说明
          .filter((x) => !p.skill || !/^\u2606/.test(x));
        if (parts.length > 1) {
          return parts.map((d) => {
            const m = d.match(/^(.+?)[：:]([\s\S]*)$/);
            return block(m ? m[1] : (s.name || '技能'), m ? m[2].trim() : d);
          }).join('');
        }
        return block(s.name || '技能', s.desc || '');
      }).join('');
      // ★ 介绍里写「神·赵云」这类带势力名的全称；称号仍是单独一行小字
      return '<div class="hi-head">' + esc(introNameOf(p)) +
        '<span class="hi-title">' + esc(ch.title || '') + '</span></div>' +
        '<div class="hi-meta">势力 ' + esc(ch.faction || '群') +
        ' · 体力 ' + p.hp + '/' + p.maxHp +
        (noHand ? '' : ' · 手牌 ' + (p.hand || []).length) + '</div>' + body;
    }

    /**
     * 单个角色框的渲染（名字 / 体力 / 手牌数 / 势力 / 立绘 / 信息浮层）。
     * 从 render() 里抽出来，供客机差量渲染只刷新真正变化的那一侧。
     */
    renderSide(p, prefix) {
      const faction = p.char.faction || '群';
      const shownName = displayNameOf(p);
      const nameEl = $(prefix + '-name');
      if (nameEl) nameEl.textContent = shownName;       // ★ 只写名字，不叠势力
      const hpEl = $(prefix + '-hp');
      if (hpEl) hpEl.innerHTML = this.hpHTML(p);        // 体力点竖排（自上而下扣除）
      // 对手：角色卡左下角只写手牌张数数字；玩家：底部手牌区显示文字
      const cnt = $(prefix + '-count');
      const countText = prefix === 'ai'
        ? String(p.hand.length)
        : '手牌 ' + p.hand.length + ' 张';
      if (cnt && cnt.textContent !== countText) cnt.textContent = countText;
      const f = $(prefix + '-faction');
      if (f) { f.textContent = faction; f.dataset.faction = faction; }

      // 角色图片：探测成功才设置 src 并启用 has-art；失败保持 CSS 绘制。
      // 只在 src 变化时重设，避免每次 render 都重新加载 / 闪烁。
      const hero = $(prefix + '-area');
      const artEl = $(prefix + '-art');
      if (!hero || !artEl) return;
      const artUrl = (this.art.characters[p.char.id]) || '';
      // ★ 名字竖排在左侧、紧接势力图标下方，字号固定与势力一致。
      //   只把名字字数（换算成 1/字数 保护系数）与体力圆点数交给 CSS。
      if (hero.style && typeof hero.style.setProperty === 'function') {
        const len = Math.max(1, shownName.length);
        hero.style.setProperty('--name-scale', (1 / len).toFixed(4));
        hero.style.setProperty('--hp-pips', String(Math.max(1, p.maxHp || 1)));
      }
      if (artEl.dataset.art !== artUrl) {
        artEl.dataset.art = artUrl;
        artEl.style.display = '';
        hero.classList.remove('has-art');
        if (artUrl) artEl.src = artUrl;
      }
      if (artUrl) hero.classList.add('has-art');
      else hero.classList.remove('has-art');
      // ★ 角色信息浮层内容随体力 / 手牌实时刷新；显隐由 CSS hover + 点击 class 控制
      const info = $(prefix + '-info');
      if (info) info.innerHTML = this.heroInfoHTML(p);
    }

    /**
     * 按 data-id 同步 #me-hand 的 DOM（视图模式 / 快照共用的 keyed diff）。
     *
     * ★ 为什么要共用：飞牌替身会把「真牌」临时 visibility:hidden，FLIP 也会
     *   给留下来的牌挂 inline transform。此时任何一次 innerHTML 重建都会让
     *   真牌重新显露 / 位移归零 —— 客机在无懈询问等 ask 重绘时看到的「小拉回」
     *   正是这么来的。这里只增删 / 重排真正变化的节点，未变化的节点身份、
     *   class 之外的内联样式一律保留。
     *
     * @returns {boolean} 是否发生了增删 / 重排（只有 class 变化返回 false）
     */
    syncHandDOM(hand, optsFor) {
      const handEl = $('me-hand');
      if (!handEl || typeof document === 'undefined' ||
          typeof document.querySelectorAll !== 'function') return false;
      let kids = [];
      try {
        kids = Array.prototype.slice.call(document.querySelectorAll('#me-hand .card'));
      } catch (e) { return false; }
      // ★ 正在飞出手牌区的那几张按「已离手」处理：否则快照重绘会把状态里
      //   还没删掉的牌重新塞回手牌区，牌已飞走、原位又闪一下原牌。
      const viewHand = this.visibleHand(hand);
      const wanted = viewHand.map((c) => ({ card: c, id: String(c.id) }));
      const kidIds = kids.map((k) => k && k.dataset && k.dataset.id != null
        ? String(k.dataset.id) : '');
      const same = wanted.length === kids.length &&
        wanted.every((w, i) => w.id === kidIds[i]);
      const applyClass = (node, c) => {
        if (!node || !node.classList || !optsFor) return;
        const html = this.cardHTML(c, optsFor(c));
        const m = /^<div class="([^"]*)"/.exec(html);
        if (m && node.className !== m[1]) node.className = m[1];
      };
      if (same) {
        kids.forEach((k, i) => applyClass(k, wanted[i].card));
        return false;
      }
      const byId = {};
      kids.forEach((k) => {
        const id = k && k.dataset && k.dataset.id;
        if (id != null) byId[String(id)] = k;
      });
      const ids = wanted.map((w) => w.id);
      kids.forEach((k) => {
        const id = k && k.dataset && String(k.dataset.id);
        if (ids.indexOf(id) < 0 && handEl.removeChild) handEl.removeChild(k);
      });
      let ref = null;
      for (let i = wanted.length - 1; i >= 0; i--) {
        const w = wanted[i];
        let node = byId[w.id];
        if (!node) {
          const holder = document.createElement('div');
          holder.innerHTML = this.cardHTML(w.card, optsFor ? optsFor(w.card) : null);
          node = holder.firstElementChild ||
            (holder.children && holder.children[0]) || holder.firstChild;
          if (!node) continue;
        }
        applyClass(node, w.card);
        if (typeof handEl.insertBefore === 'function') handEl.insertBefore(node, ref || null);
        else handEl.appendChild(node);
        ref = node;
      }
      return true;
    }

    /**
     * ★ 客机专用：按「牌 id」做差量渲染。
     *
     * 主机快照每次都包含全部角色 / 手牌数据，但两次快照之间真正变化的往往
     * 只有一两张牌。原先客机 onSnap 直接走 render()，会整块重建 #me-hand 的
     * innerHTML —— 未变化的牌也换了 DOM 身份，CSS 过渡被掐断、图片重复解码，
     * 正在飞的牌也更容易和重建后的手牌打架。
     *
     * 这里只更新真正变了的区域；手牌按 data-id 复用旧节点，只增删 / 移动
     * 有变化的那些，未变化的节点连 class 与内联样式都原样保留（选牌高亮、
     * 刚选中动画因此不会被快照冲掉）。pending 驱动的按钮 / 目标高亮由 ask
     * 路径的完整 render() 负责，本方法不碰。
     */
    renderPatch(game, prev, snap) {
      if (!game || !snap || !game.human || !game.aiPlayer) return;
      const $ = (id) => (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById(id) : null;
      const setText = (id, v) => {
        const e = $(id); if (e && e.textContent !== v) e.textContent = v;
      };
      const setHTML = (id, v) => {
        const e = $(id); if (e && e.innerHTML !== v) e.innerHTML = v;
      };
      const sig = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
      // 只比较会影响画面的字段，避免 char 对象里的方法 / 引用造成假变化。
      const dSig = (d) => !d ? '' : sig({
        name: d.name, hp: d.hp, maxHp: d.maxHp, chained: d.chained,
        handCount: d.handCount, handIds: d.handIds,
        hand: (d.hand || []).map((c) => c.id),
        delayed: (d.delayed || []).map((c) => c.id),
        equips: d.equips
      });
      const cur = {};
      (snap.players || []).forEach((d) => { cur[d.seat] = d; });
      const old = {};
      ((prev && prev.players) || []).forEach((d) => { old[d.seat] = d; });
      const me = game.human, ai = game.aiPlayer;
      const meChanged = !prev || dSig(old[me.seat]) !== dSig(cur[me.seat]);
      const aiChanged = !prev || dSig(old[ai.seat]) !== dSig(cur[ai.seat]);

      setText('round-info', '第 ' + game.round + ' 轮 · ' +
        (game.actor.isHuman ? '你的回合'
          : (game.vsAI === false ? '对手回合' : 'AI 回合')));
      setText('deck-info', '牌堆 ' + game.deck.remaining + ' 张 / 弃牌 ' +
        (game.deck.discardPile ? game.deck.discardPile.length : 0) + ' 张');
      setText('ai-seat', game.players.length > 1 ? SGS.seatLabel(ai.seat || 2) : '');
      setText('me-seat', game.players.length > 1 ? SGS.seatLabel(me.seat || 1) : '');

      if (meChanged) this.renderSide(me, 'me');
      if (aiChanged) this.renderSide(ai, 'ai');
      if (meChanged || aiChanged) this.renderEquips(game);
      if (meChanged) setHTML('me-judge-marks', this.judgeMarkHTML(me));
      if (aiChanged) setHTML('ai-judge', this.judgeMarkHTML(ai));

      const aiArea = $('ai-area'), meArea = $('me-area');
      if (aiArea && aiArea.classList) aiArea.classList.toggle('acting', game.actor === ai);
      if (meArea && meArea.classList) meArea.classList.toggle('acting', game.actor === me);

      // ★ 手牌 keyed diff：与 render() 的视图模式共用同一套同步逻辑。
      if (!$('me-hand') || typeof document.querySelectorAll !== 'function') return;
      const before = this._handFlipSuppress ? null : this.captureHandRects();
      const changed = this.syncHandDOM(me.hand, null);
      this.clearPredictMovers();
      if (!changed) return;
      this.layoutHand(this.visibleHand(me.hand).length);
      if (before) this.playHandFlip(before);
    }

    render(game) {
      if (!game) return;
      // ★ 联机钩子：主机每次状态渲染都推一次按座位裁剪的权威快照。
      //   客机不设置此钩子，避免「收快照 → render → 再发快照」的循环。
      if (this.onRender) { try { this.onRender(game); } catch (e) {} }
      const me = game.human;
      const ai = game.aiPlayer;
      const pd = this.pending;

      $('round-info').textContent = '第 ' + game.round + ' 轮 · ' +
        (game.actor.isHuman ? '你的回合'
          : (game.vsAI === false ? '对手回合' : 'AI 回合'));
      $('deck-info').textContent = '牌堆 ' + game.deck.remaining + ' 张 / 弃牌 ' +
        (game.deck.discardPile ? game.deck.discardPile.length : 0) + ' 张';

      this.renderSide(ai, 'ai');
      this.renderSide(me, 'me');
      this.renderEquips(game);   // 玩家四栏装备区 + 其他角色框内迷你装备栏

      // 判定区图标：玩家在底部手牌区左上方的独立区域，其他角色在角色框下边框
      const meJudge = $('me-judge-marks');
      if (meJudge) meJudge.innerHTML = this.judgeMarkHTML(me);
      const aiJudge = $('ai-judge');
      if (aiJudge) aiJudge.innerHTML = this.judgeMarkHTML(ai);

      // 行动顺序序号：一号位先手，其余按逆时针（players 数组顺序）。
      // ★ 1v1 座次随机后也显示，否则玩家看不出为什么这局是对手先动；
      //   对手序号落在角色框外下方，自己的序号落在框内下方。
      //   用数组下标兜底，将来往 players 里插入其他玩家时序号仍自动成立。
      const seatOf = (p) => p.seat || (game.players.indexOf(p) + 1);
      const showSeats = game.players.length > 1;
      $('ai-seat').textContent = showSeats ? SGS.seatLabel(seatOf(ai)) : '';
      $('me-seat').textContent = showSeats ? SGS.seatLabel(seatOf(me)) : '';

      // 目标选择：只有合法目标角色卡会高亮可点（1v1 下即对方那张）。
      // ★ 借刀杀人的「一次选两名」：第一次高亮有武器的目标；选定后
      //   立刻改为高亮该目标的【杀】合法目标（含使用者自己的角色框）。
      let targetable = [];
      if (pd && pd.mode === 'target') {
        targetable = pd.targets || [];
      } else if (pd && pd.mode === 'targets' && pd.game) {
        if (!pd.picked || !pd.picked.length) targetable = pd.targets || [];
        else targetable = pd.game.listTargets(pd.picked[0], { type: 'sha' }, 'sha');
      } else if (pd && pd.mode === 'chainTargets') {
        targetable = pd.targets || [];   // ★ 铁索：所有角色（含自己）都高亮
      }
      $('ai-area').classList.toggle('targetable', targetable.indexOf(ai) >= 0);
      $('me-area').classList.toggle('targetable', targetable.indexOf(me) >= 0);
      // ★ 需要多选目标的牌（借刀杀人 / 铁索连环 / 方天画戟…）：已选中的
      //   角色框改为「静态高亮 + 点击序号」，不再跟着合法目标的金色脉冲
      //   一起跳动，和还没选的目标一眼可分。序号即点击顺序（借刀两次
      //   点击、铁索 / 方天的目标顺序都以此为准）。
      this.markPickedTargets(pd, ai, me);
      // ★ 目标选择期间角色介绍一律不弹（连 hover 也由 CSS 压住），
      //   并清掉上一步点击残留的 info-open，避免浮层盖住目标高亮。
      const selecting = !!pd && (pd.mode === 'target' || pd.mode === 'targets' ||
        pd.mode === 'chainTargets');
      const app = $('app');
      if (app && app.classList) app.classList.toggle('selecting-target', selecting);
      if (selecting) {
        $('ai-area').classList.remove('info-open');
        $('me-area').classList.remove('info-open');
      }

      // ★ 铁索连环：连环状态（横置）在角色框正中间画一条横向锁链
      const aiChain = $('ai-chain'), meChain = $('me-chain');
      if (aiChain && aiChain.classList) aiChain.classList.toggle('hidden', !ai.chained);
      if (meChain && meChain.classList) meChain.classList.toggle('hidden', !me.chained);

      // 玩家手牌：出牌 / 技能选牌 / 响应选闪 / 弃牌共用同一套高亮与刚选中动画。
      // justPicked 只标记本次新选中的那张，避免每次重绘时已选卡牌一起重播动画。
      const nonHandMode = !!pd &&
        (pd.mode === 'target' || pd.mode === 'targets' ||
         pd.mode === 'trick' || pd.mode === 'optional' ||
         pd.mode === 'wugu' || pd.mode === 'peek' ||
         pd.mode === 'chainTargets' ||
         pd.mode === 'choice' || pd.mode === 'wuxie');
      let selected = [];
      if (pd && !nonHandMode) {
        if (Array.isArray(pd.selected)) {
          selected = pd.selected;
        } else if (pd.mode === 'skill' && pd.card) {
          selected = [pd.card.id];
        } else if (pd.selected) {
          selected = [pd.selected];
        }
      }
      // ★「刚选中」只标记本次 render 相对上一次**新增**的那张牌：
      //   加选 [A]→[A,B] 时是 B；减选 [A,B]→[A]、整批取消、或非点击原因
      //   的重绘（立绘晚到 / 状态刷新）都没有新增 → justPicked = null。
      //   旧写法取 selected 末位，减选后末位回退到 A，会让仍选中的 A 重播
      //   card-pick 上浮动画，看起来就是「取消选牌时上一张牌上下跳动」。
      const prevSel = (pd && Array.isArray(pd._renderSelected))
        ? pd._renderSelected : [];
      const justPicked = selected.filter((id) => prevSel.indexOf(id) < 0)[0] || null;
      if (pd) pd._renderSelected = selected.slice();
      // 只有「正在等待玩家本人操作」时手牌才可点；
      // 技能选牌 / 响应选牌模式下，不能用于本次操作的牌一并置灰，形成引导。
      // respondNeed 决定响应要【闪】还是【杀】，技能模式同理按 need 过滤。
      const baseDim = !pd || pd.player !== me || nonHandMode;
      const skillMode = !!pd && pd.mode === 'skill';
      const respondMode = !!pd && pd.mode === 'respond';
      const pickMode = !!pd && pd.mode === 'pick';
      const brinkMode = !!pd && pd.mode === 'brink';
      const respondNeed = (pd && pd.respondNeed) || 'shan';
      // ★ 自动 FLIP：重建前记录旧手牌位置，重建后让留下来的牌平滑合拢。
      //   flipInsertIntoHand 会临时置 suppress（它自己已做让位，避免叠加）。
      const handFlipBefore = this._handFlipSuppress ? null : this.captureHandRects();
      const handOpts = (c) => ({
        selected: selected.indexOf(c.id) >= 0,
        justPicked: c.id === justPicked,
        dim: baseDim ||
          (skillMode && !findConversion(pd.player, c, pd.scene, pd.respondNeed, pd.skillName)) ||
          (respondMode && !SGS.Cards.matchesRespond(c, respondNeed)) ||
          (pickMode && pd.pickFilter && !pd.pickFilter(c)) ||
          (brinkMode && !(pd.saves || []).some((s) => s.id === c.id))
      });
      // ★ 客机视图模式：ask 触发的 render() 也走 keyed diff，绝不重建手牌 DOM。
      //   否则无懈询问到来时，正在飞的真牌会「重新冒出来」，表现为小拉回。
      // ★ 正在飞出手牌区的那几张（_departing）不算在手牌里：手牌区按「少一张」
      //   布局，飞牌动画期间不会被快照 / ask 重绘拉回来。
      const viewHand = this.visibleHand(me.hand);
      if (this._netView && typeof this.syncHandDOM === 'function' &&
          typeof document.querySelectorAll === 'function') {
        if (this.syncHandDOM(me.hand, handOpts)) {
          this.layoutHand(viewHand.length);
          if (handFlipBefore) this.playHandFlip(handFlipBefore);
        }
      } else {
        $('me-hand').innerHTML = viewHand.map((c) => this.cardHTML(c, handOpts(c))).join('');
        this.layoutHand(viewHand.length);
        if (handFlipBefore) this.playHandFlip(handFlipBefore);
      }
      this.clearPredictMovers();

      // 当前行动方描边
      $('ai-area').classList.toggle('acting', game.actor === ai);
      $('me-area').classList.toggle('acting', game.actor === me);
    }

    /* ---------------- 中央展示区（最多 5 张，死亡弃置不受上限） ---------------- */

    /** 展示区里仍在队列中的卡片（排除正在向左滑出的那张） */
    showcaseItems() {
      const box = $('table-card');
      if (!box || !box.children) return [];
      return Array.prototype.slice.call(box.children).filter((el) =>
        el.classList && el.classList.contains('show-item') &&
        !el.classList.contains('leaving')
      );
    }

    /**
     * 把一段卡面 HTML 放进展示区：从左到右排列，常规上限 5 张。
     * 超过上限时最左边那张向左滑出消失（阵亡弃置条目豁免），
     * 其余牌用 FLIP 平滑左移，新牌从右侧淡入并落在最右边。
     * 若总宽超出展示区，自动按可用宽度计算负边距堆叠，不裁切卡牌。
     * 回合结束时由 clearTableCard 清空。
     *
     * 普通出牌、判定牌亮出、改判牌亮出都走这里，保证队列与溢出动画完全一致。
     * opts.judge=true 给条目加 .judge-item（供 markJudgeResult 找到最后一张），
     * opts.label 在牌下方加一行小标签（如「判定牌」/「改判牌」）。
     * @returns {object|null} 新建的 show-item 节点
     */
    enqueueShowcase(inner, opts) {
      opts = opts || {};
      const box = $('table-card');
      if (!box) return null;
      const items = this.showcaseItems();
      const before = items.map((el) => ({
        el,
        left: typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().left : 0
      }));

      // ★ 阵亡弃置条目完全不占 5 张上限：它进来时不挤掉任何牌，
      //   后续常规牌仍按「常规牌满 5 张」淘汰最早的常规牌。
      const normalItems = items.filter((el) =>
        !(el.classList && el.classList.contains('death-item')));
      if (!opts.death && normalItems.length >= this.SHOWCASE_LIMIT) {
        const oldest = normalItems[0];
        const bi = before.findIndex((rec) => rec.el === oldest);
        if (bi >= 0) before.splice(bi, 1);
        oldest.classList.add('leaving', 'slide-out');
        if (typeof oldest.getBoundingClientRect === 'function') {
          const r = oldest.getBoundingClientRect();
          oldest.style.position = 'fixed';
          oldest.style.left = r.left + 'px';
          oldest.style.top = r.top + 'px';
          oldest.style.width = r.width + 'px';
          oldest.style.margin = '0';
        }
        SGS.sleep(360).then(() => {
          if (oldest.parentNode && oldest.parentNode.removeChild) {
            oldest.parentNode.removeChild(oldest);
          }
          this.layoutShowcase();
        });
      }

      const item = document.createElement('div');
      item.className = 'show-item enter' + (opts.judge ? ' judge-item' : '') +
        (opts.death ? ' death-item' : '');
      item.innerHTML = inner +
        (opts.label ? '<div class="judge-label">' + opts.label + '</div>' : '');
      box.appendChild(item);

      // 先按新条目重新排布（必要时叠放），再用 FLIP 把旧牌「拉回」原位过渡
      this.layoutShowcase();

      // FLIP：先把旧牌反向位移到「看起来还在原位」，再过渡回 0 → 平滑左移
      if (typeof requestAnimationFrame === 'function') {
        before.forEach((rec) => {
          if (typeof rec.el.getBoundingClientRect !== 'function') return;
          const now = rec.el.getBoundingClientRect().left;
          const dx = rec.left - now;
          if (Math.abs(dx) > 0.5) {
            rec.el.style.transition = 'none';
            rec.el.style.transform = 'translateX(' + dx + 'px)';
          }
        });
        requestAnimationFrame(() => {
          before.forEach((rec) => {
            rec.el.style.transition = 'transform .35s ease';
            rec.el.style.transform = '';
          });
          item.classList.remove('enter');
        });
      } else {
        item.classList.remove('enter');
      }
      return item;
    }

    /**
     * 展示区超宽时自动堆叠：卡牌保持原尺寸，用负 margin 相互遮盖，
     * 保证 5 张（或更多阵亡弃置条目）始终落在展示区内。
     */
    layoutShowcase() {
      const box = $('table-card');
      if (!box || !box.style) return;
      box.style.setProperty('--show-overlap', '0px');
      const items = this.showcaseItems();
      if (items.length < 2) return;
      let total = 0;
      items.forEach((el) => {
        const w = typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect().width : 0;
        total += w;
      });
      let gap = 0;
      try {
        if (typeof getComputedStyle === 'function') {
          gap = parseFloat(getComputedStyle(box).columnGap) || 0;
        }
      } catch (e) { /* 无样式环境按 0 处理 */ }
      total += gap * (items.length - 1);
      const avail = box.clientWidth ||
        (typeof box.getBoundingClientRect === 'function'
          ? box.getBoundingClientRect().width : 0);
      if (!avail || total <= avail) return;
      const overlap = Math.ceil((total - avail) / (items.length - 1));
      box.style.setProperty('--show-overlap', '-' + overlap + 'px');
    }

    /**
     * 普通出牌 / 响应牌进展示区。
     * asName 画『当作【X】』（技能转化牌），note 画同一位置的自定义说明，
     * 例如被替换下的旧装备『替换弃置』、过河拆桥弃掉的牌『过河拆桥弃置』。
     */
    showTableCard(card, asName, note, opts) {
      return this.enqueueShowcase(
        this.cardHTML(card) +
        (asName ? '<div class="as-label">当作【' + asName + '】</div>' : '') +
        (note ? '<div class="as-label">' + note + '</div>' : ''),
        opts || {}
      );
    }

    /**
     * 阵亡弃置：手牌 / 装备 / 判定区的牌一次性放进展示区（不逐张飞牌），
     * 每张牌下方用与「过河拆桥弃置」相同的 .as-label 位置标「XX阵亡弃置」。
     * 这些条目带 .death-item，不占用常规 5 张上限。
     */
    showDeathDiscard(player, cards) {
      const name = player && player.name ? player.name : '角色';
      (cards || []).forEach((card) => {
        this.enqueueShowcase(
          this.cardHTML(card) +
          '<div class="as-label">' + name + '阵亡弃置</div>',
          { death: true }
        );
      });
    }

    /**
     * 判定牌亮出：与普通牌共用展示区队列，额外打上 .judge-item 与
     * 「判定牌 / 改判牌」标签，方便后面在同一张牌上画生效 / 失效标记。
     */
    showJudgeCard(card, label) {
      return this.enqueueShowcase(this.cardHTML(card), {
        judge: true, label: label || '判定牌'
      });
    }

    /**
     * 判定生效 / 失效标记：给展示区**最后一张**判定牌加 class，
     * 由 CSS 画绿色对号 + 「生效」或红色叉号 + 「失效」的动画。
     * 改判过则标在改判后的那张牌上（它就是最后一张）。
     */
    markJudgeResult(effective) {
      const box = $('table-card');
      if (!box) return;
      const items = this.showcaseItems().filter(
        (el) => el.classList && el.classList.contains('judge-item')
      );
      const last = items[items.length - 1];
      if (!last) return;
      last.classList.remove('judge-ok', 'judge-fail');
      // 强制重排，连续两次判定时动画能重新播放
      if (typeof last.offsetWidth === 'number') void last.offsetWidth;
      last.classList.add(effective ? 'judge-ok' : 'judge-fail');
    }

    /** 清空展示区（Game.runTurn 在角色回合结束时调用） */
    clearTableCard() {
      const box = $('table-card');
      if (!box) return;
      box.innerHTML = '';
      box.style.setProperty('--show-overlap', '0px');
    }

    /**
     * ★ 一次性把多张牌放进展示区队列（批量弃牌用）。
     *   · 先按顺序全部 enqueue，再统一清掉连续入队产生的临时 FLIP 位移，
     *     量出每张牌【最终那一格】的矩形，保证所有飞牌落点精确、互不漂移
     *   · 真 show-item 先隐藏，由各自的飞牌代替；落地由 flyCard 统一恢复
     *   · 只做一次 layoutShowcase()，展示区旧牌整体让位一次，不再一张张挤
     * @returns {Array<{card, item, rect}>|null} 无展示区时返回 null
     */
    showTableCardsBatch(cards, opts) {
      opts = opts || {};
      const box = $('table-card');
      if (!box || !cards || !cards.length) return null;
      const R = (el) => el && typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect() : null;
      const items = cards.map((c) => {
        const it = this.showTableCard(c, opts.asName, opts.note, opts.showOpts || {});
        if (it && it.classList) it.classList.remove('enter');  // 去掉入场位移
        return it;
      });
      if (items.some((it) => !it)) return null;
      // 连续 enqueue 会给先加入的 item 临时反向位移，量取前统一归零
      items.forEach((it) => {
        if (!it.style) return;
        it.style.transform = '';
        it.style.transition = '';
      });
      this.layoutShowcase();
      return cards.map((c, i) => {
        const it = items[i];
        const inner = typeof it.querySelector === 'function'
          ? it.querySelector('.card') : null;
        const r = R(inner) || R(it);
        if (it.style) it.style.visibility = 'hidden';
        return {
          card: c, item: it,
          rect: (r && r.width)
            ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
        };
      });
    }

    /**
     * ★ 玩家一次性弃 / 打出多张牌：所有飞牌【同时起飞、同时落地】，
     *   展示区也一次性让位，不再一张张串行蹦出来（弃 3 张原本要 3×520ms）。
     * 只有「玩家本人 + 多张 + 纯手牌出展示区」才走批量；AI / 单张 /
     * 被拆被牵等强制来源自动退化成原来的逐张 flyCard，行为完全不变。
     * 无 DOM 动画能力时同样逐张落地，自测与假界面不受影响。
     */
    flyCards(cards, fromPlayer, opts) {
      opts = opts || {};
      cards = (cards || []).filter(Boolean);
      if (!cards.length) return Promise.resolve();
      const app = $('app');
      // ★ opts.batch：客机重放主机「玩家批量弃牌」时用。客机视角下那位玩家
      //   落在 aiPlayer（isHuman=false），单靠 isHuman 判定会退化成逐张飞、
      //   全部落到展示区中央叠在一起；显式标记后走与主机完全相同的
      //   showTableCardsBatch → 每张各有最终格、同时起飞、同时落地。
      const canBatch = app && $('table-card') && cards.length > 1 &&
        !opts.onArrive && !opts.from && !opts.faceDown &&
        (opts.dest || 'showcase') === 'showcase' &&
        this.game &&
        (opts.batch || (fromPlayer && fromPlayer.isHuman)) &&
        typeof app.appendChild === 'function' &&
        typeof document.createElement === 'function';
      if (!canBatch) {
        return Promise.all(cards.map((c) => this.flyCard(c, fromPlayer, opts)))
          .then(() => undefined);
      }
      const batch = this.showTableCardsBatch(cards, opts);
      if (!batch || batch.some((b) => !b.item || !b.rect)) {
        // 已经入队但量不到落点：恢复显示，退回逐张（不重复入队）
        if (batch) batch.forEach((b) => {
          if (b.item && b.item.style) b.item.style.visibility = '';
        });
        return Promise.all(cards.map((c) => this.flyCard(c, fromPlayer, opts)))
          .then(() => undefined);
      }
      return Promise.all(cards.map((c, i) =>
        this.flyCard(c, fromPlayer, Object.assign({}, opts, {
          committedItem: batch[i].item,
          targetRect: batch[i].rect
        }))
      )).then(() => undefined);
    }

    /**
     * 卡牌平滑移动：从来源（手牌区 / 角色框）飞到展示区，或飞到手牌末尾。
     * 用一张 .fly-card 克隆卡做位移动画；到达后：
     *   dest==='showcase' → 玩家自己出牌时，真牌在【起飞前】就已放入展示区
     *      （展示区旧牌 FLIP 让位与飞牌同时进行），飞牌精确落到它最终那一格
     *      并在飞行中缩到展示区尺寸；被拆 / 替换旧装备等仍走落地入队
     *   dest==='hand'     → opts.onArrive（把牌收进手牌并重绘，走插入手牌动画）
     *   dest==='equip'    → opts.onArrive（装上装备并重绘装备区，落地溶接淡入）
     * ★ 手牌区里所有「留下来的牌」由 render() 内置 FLIP 平滑合拢，
     *   出牌 / 弃牌 / 装备之后不再瞬间跳位；被飞出的那张真 DOM 起飞时隐藏。
     * dest==='hand' 的落点与摸牌动画共用 handAppendX()，接在现有手牌最右边。
     * dest==='equip' 与 faceDown 一样统一用真实卡牌尺寸，避免 AI 从角色框
     * 出发时画出一张「框那么大的牌」。
     * 动画返回 Promise，供主循环 await，因此后续结算一定发生在落地之后。
     */
    flyCard(card, fromPlayer, opts) {
      opts = opts || {};
      const dest = opts.dest || 'showcase';
      const app = $('app');
      // ★ 玩家自己出牌进展示区时，会在飞牌起飞前先把真牌放进队列
      //   （让展示区旧牌 FLIP 让位与飞牌同时进行、落点精确对齐）。
      //   这里记下那个 show-item，arrive 就不再重复入队。
      //   opts.committedItem / opts.targetRect 由 flyCards() 批量模式预先算好，
      //   多张牌一次性入队、一次性起飞时不再各自 commit，避免重复与落点漂移。
      let showcaseCommitted = opts.committedItem || null;
      const arrive = () => {
        if (opts.onArrive) opts.onArrive();
        else if (dest === 'showcase' && !showcaseCommitted) {
          this.showTableCard(card, opts.asName, opts.note);
        }
      };
      const canAnimate = app && typeof app.appendChild === 'function' &&
        typeof app.getBoundingClientRect === 'function' &&
        typeof document.createElement === 'function';
      if (!canAnimate) { arrive(); return Promise.resolve(); }

      const R = (el) => el && typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect() : null;
      const hero = R($(fromPlayer && fromPlayer.isHuman ? 'me-area' : 'ai-area')) || R(app);

      // 来源：自己用/打出的牌从手牌区（优先精确那张）出发；其他角色从角色框出发。
      // opts.from==='hero' 用于被拆 / 被牵的牌，强制从目标角色框出发；
      // opts.from==='equip' 用于被同槽替换下来的旧装备，从对应装备槽出发。
      let src = hero;
      let handCardEl = null;   // 玩家手牌里被飞出的那张真 DOM（起飞时隐藏）
      const fromHand = !opts.from && fromPlayer && fromPlayer.isHuman;
      // ★ from:'table' = 从中央展示区/牌堆起飞（联机客机重放摸牌动画用）。
      //   不这么指定时，fromPlayer.isHuman 会从手牌区起飞、对手会从角色框起飞，
      //   与 dest='hand'/'ai-hero' 落点重叠 → 飞牌几乎原地不动，看起来没动画。
      if (opts.from === 'table') {
        src = R($('table-card')) || R(app);
      } else if (opts.from === 'equip') {
        const slot = opts.slot || 'weapon';
        if (fromPlayer && fromPlayer.isHuman) {
          src = R($('me-equip-' + slot)) || R($('me-equip-area')) || hero;
        } else {
          let mini = null;
          try {
            if (typeof document.querySelector === 'function') {
              mini = R(document.querySelector(
                '#ai-equips .eq-mini-row[data-slot="' + slot + '"]'
              ));
            }
          } catch (e) { mini = null; }
          src = mini || R($('ai-area')) || hero;
        }
      } else if (fromHand) {
        let handCard = null;
        try {
          if (typeof document.querySelector === 'function') {
            handCard = document.querySelector('#me-hand .card[data-id="' + card.id + '"]');
          }
        } catch (e) { handCard = null; }
        const r = R(handCard);
        if (r && r.width) {
          src = r;
          // 起飞后这张真牌会被摘掉（predictHandDeparture），避免与克隆飞牌重影
          handCardEl = handCard;
        } else {
          src = R($('me-hand')) || hero;
        }
      }
      if (!src || !src.width) { arrive(); return Promise.resolve(); }

      // 'hand' = 玩家手牌区最右；'ai-hero' = AI 偷牌时飞向 AI 角色框
      // （AI 手牌没有独立区域，用角色框代表其手牌）；
      // 'equip' = 装备牌飞向对应装备槽；其余一律飞向展示区中央。
      const destEl = dest === 'hand' ? ($('me-hand') || $('me-area'))
        : dest === 'ai-hero' ? $('ai-area')
        : dest === 'equip' ? ($('me-equip-area') || $('table-card'))
        : $('table-card');
      const dRect = R(destEl) || R(app);
      let w = src.width, h = src.height;
      // ★ 背面朝上的牌（暗手牌被牵）、装备牌，以及一切从角色框 / 装备槽出发的牌
      //   （被拆 / 被牵 / 被替换，含装备区 / 判定区的明牌），直接用角色框尺寸会画出
      //   一张「框那么大的牌」。这里改成真实卡牌尺寸，并把起点收拢到角色框
      //   中央：与摸牌动画尺寸一致，落点也能精确对接装备槽 / 手牌最右边。
      if (opts.faceDown || opts.from === 'hero' || opts.from === 'equip' ||
          opts.from === 'table' || dest === 'equip' ||
          dest === 'hand' || dest === 'ai-hero') {
        let sample = null;
        try {
          if (typeof document.querySelector === 'function') {
            sample = R(document.querySelector('#me-hand .card'));
          }
        } catch (e) { sample = null; }
        if (sample && sample.width > 10) { w = sample.width; h = sample.height; }
        else {
          const handR = R($('me-hand')) || dRect;
          h = Math.max(48, Math.min(handR.height * 0.8, 110));
          w = h * 5 / 7;
        }
        src = {
          left: src.left + (src.width - w) / 2,
          top: src.top + (src.height - h) / 2,
          width: w, height: h
        };
      }

      // ★ 客机视图里的「进入手牌」：状态已由权威快照同步，onArrive 被剥掉，
      //   但仍要和主机一样走「插入手牌」动画 —— 真牌先隐藏、从牌堆飞进自己
      //   最终那一格，手牌整理与飞牌同帧完成，不会先出牌再瞬间跳位。
      if (this._netView && dest === 'hand' && this.game &&
          typeof this.flipInsertIntoHand === 'function' &&
          typeof opts.onArrive !== 'function' &&
          typeof document.querySelectorAll === 'function') {
        return this.flipInsertIntoHand([card], this.game.human, this.game, {
          sourceRect: { left: src.left, top: src.top, width: src.width, height: src.height },
          // ★ 连摸多张时把逐张错峰一起带进去，观感与主机 animateDraw 一致
          delay: opts.delay || 0,
          viewOnly: true
        });
      }

      // ★ 玩家获得牌（顺手牵羊 / 借刀杀人等）：与「玩家自己摸牌」共用同一套
      //   「插入手牌」动画 —— 旧牌 FLIP 平滑让位，新牌【正面朝上】飞进自己
      //   最终的格子，不再背面朝上、也不再落地瞬间跳位。
      //   opts.onArrive 作为 commit 在动画开场执行（牌此刻入队，真 DOM 先隐藏）。
      //   AI 获得牌（dest==='ai-hero'）仍走下面的背面飞牌，手牌保持不可见。
      if (dest === 'hand' && this.game &&
          typeof this.flipInsertIntoHand === 'function' &&
          typeof opts.onArrive === 'function' &&
          typeof document.querySelectorAll === 'function') {
        return this.flipInsertIntoHand([card], this.game.human, this.game, {
          sourceRect: { left: src.left, top: src.top, width: src.width, height: src.height },
          commit: opts.onArrive
        }).then((handled) => { if (!handled) opts.onArrive(); });
      }

      /**
       * ★ 玩家自己从手牌打出 → 展示区：起飞前先把真牌放进展示区队列。
       *   · 展示区旧牌的 FLIP 左移 / 最左滑出与飞牌同时进行，不再「落地才挤」
       *   · 量到新建 show-item 里那张牌的最终矩形作为飞牌终点，
       *     飞牌在飞行中同步缩到展示区的 0.6 倍尺寸 → 落地零跳位
       *   · 真 show-item 先用 visibility 隐藏，飞牌代替它；落地恢复
       * 仅限「无 onArrive、无强制来源」的纯出牌；被拆 / 被牵 / 替换旧装备 /
       * 判定亮牌等仍走原来的落地入队路径，不受影响。
       */
      let targetRect = opts.targetRect || null;
      const purePlayToShowcase = dest === 'showcase' && !opts.onArrive && !opts.from &&
        !opts.committedItem && !opts.targetRect &&
        fromPlayer && fromPlayer.isHuman && this.game &&
        typeof document.createElement === 'function';
      if (purePlayToShowcase) {
        try {
          showcaseCommitted = this.showTableCard(card, opts.asName, opts.note);
          if (showcaseCommitted) {
            // 去掉 .enter 再量：否则 translateY(8px) 的入场偏移会带进落点
            if (showcaseCommitted.classList) showcaseCommitted.classList.remove('enter');
            const innerCard = typeof showcaseCommitted.querySelector === 'function'
              ? showcaseCommitted.querySelector('.card') : null;
            const tr = R(innerCard) || R(showcaseCommitted);
            if (tr && tr.width) {
              targetRect = { left: tr.left, top: tr.top, width: tr.width, height: tr.height };
              showcaseCommitted.style.visibility = 'hidden';
            } else {
              showcaseCommitted = null;   // 量不到就退回旧路径
            }
          }
        } catch (e) { showcaseCommitted = null; targetRect = null; }
      }

      // ★ 多张同批飞行（联机摸牌重放）的错位参数：与 animateDrawToAI 一致，
      //   每张只露出 1/3、后一张盖住前一张 2/3，不再几张完全重叠。
      const stackCount = Math.max(1, opts.stackCount || 1);
      const stackIndex = Math.min(stackCount - 1,
        Math.max(0, opts.stackIndex == null ? 0 : opts.stackIndex));
      const stackStep = w / 3;
      let toLeft, toTop;
      if (dest === 'hand') {
        // 兼容兜底：无 game / 无 onArrive 时仍按旧落点飞（正面）
        const handR = R($('me-hand')) || dRect;
        toLeft = this.handAppendX(w, handR) - (stackCount - 1 - stackIndex) * stackStep;
        toTop = handR.top + (handR.height - h) / 2;
      } else if (dest === 'ai-hero') {
        // AI 偷牌：没有独立手牌区，飞向 AI 角色框右端代表其手牌
        toLeft = dRect.left + dRect.width - w -
          (stackCount - 1 - stackIndex) * stackStep;
        toTop = dRect.top + (dRect.height - h) / 2;
      } else if (dest === 'equip') {
        // ★ 装备牌：玩家飞到左侧装备区里对应的那一栏；其他角色飞到其
        //   角色框下半部分（迷你装备栏所在区域）。落地后由 onArrive 装状态、
        //   render() 把独立的装备 UI 画出来。
        const tp = opts.toPlayer;
        if (tp && tp.isHuman) {
          const r = R($('me-equip-' + (opts.slot || 'weapon'))) || R($('me-equip-area')) || dRect;
          toLeft = r.left + (r.width - w) / 2;
          toTop = r.top + (r.height - h) / 2;
        } else {
          const r = R($('ai-area')) || dRect;
          toLeft = r.left + r.width * 0.62 - w / 2;
          toTop = r.top + r.height * 0.72 - h / 2;
        }
      } else {
        toLeft = dRect.left + dRect.width / 2 - w / 2;
        toTop = dRect.top + dRect.height / 2 - h / 2;
      }

      const fly = document.createElement('div');
      fly.className = 'fly-card' + (targetRect ? ' to-showcase' : '');
      if (opts.stackIndex != null) fly.style.zIndex = String(21 + stackIndex);
      fly.style.left = src.left + 'px';
      fly.style.top = src.top + 'px';
      fly.style.width = w + 'px';
      fly.style.height = h + 'px';
      // ★★ 正反面的绝对判据（本地屏幕同样适用）：只有【牌的提供者】与
      //   【获得者】能看到正面，其余任何人（含单机里的 AI 对阵 AI）只看牌背。
      //   · 提供者 = 参数 fromPlayer；获得者 = opts.toPlayer，缺省按落点还原
      //     （'hand' = 本地玩家收下，'ai-hero' = 别人收下）。
      //   · 两个座位/角色都拿不到时（无 game 的自测假界面）退回 opts.faceDown。
      //   这样一来：AI 牵走你的暗手牌 → 你是提供者，看到正面；
      //   AI 牵走别人的牌 → 你两者都不是，只看到牌背。
      const faceDown = (() => {
        if (dest !== 'hand' && dest !== 'ai-hero') return !!opts.faceDown;
        // ★ 例外：全场公开的牌（五谷亮出的牌 / 装备区·判定区明牌）→ 人人看正面
        if (opts.public) return false;
        const me = this.game && this.game.human;
        if (!me) return !!opts.faceDown && dest !== 'hand';
        let recv = opts.toPlayer || null;
        if (!recv && dest === 'hand') recv = me;
        if (!recv && dest === 'ai-hero' && this.game.players) {
          // 兼容旧调用（没给 toPlayer）：1v1 里「不是我就是对手」
          recv = this.game.players.filter((p) => p && p !== me)[0] || null;
        }
        const isProvider = !!fromPlayer && fromPlayer === me;
        const isReceiver = !!recv && recv === me;
        return !(isProvider || isReceiver);
      })();
      fly.innerHTML = faceDown ? this.cardBackHTML() : this.cardHTML(card);
      app.appendChild(fly);
      // ★ 飞牌就是这张手牌的「替身」。三种处理，按顺序判定：
      //   ① opts.keepInHand（【火攻】亮牌这类「展示但不离手」）→ 只隐藏，
      //      落地恢复，牌一直在手里；
      //   ② 正常出牌 / 用装备 / 弃牌 → predictHandDeparture()：把真牌从 DOM
      //      摘掉并按「少一张」重排，留下来的牌 FLIP 合拢。摘掉 id 之后会被
      //      render / syncHandDOM 当作「已离手」，所以不会闪回原位；
      //   ③ 摘不掉（无布局环境）→ 退化为隐藏，落地再恢复。
      //   批量弃牌时只有第一张做离手预测，其余牌沿用已经开始的合拢，避免重复位移。
      let hiddenFallback = false;
      if (handCardEl) {
        let detached = false;
        if (!opts.keepInHand && dest !== 'hand' &&
            typeof this.predictHandDeparture === 'function') {
          try { detached = !!this.predictHandDeparture(handCardEl); }
          catch (e) { detached = false; }
        }
        if (!detached && handCardEl.style) {
          handCardEl.style.visibility = 'hidden';
          hiddenFallback = true;
        }
      }

      const start = () => {
        // inline longhand 覆盖 .moving 简写里的 transition-delay:0
        if (opts.delay) fly.style.transitionDelay = opts.delay + 'ms';
        fly.classList.add('moving');
        if (targetRect) {
          fly.style.left = targetRect.left + 'px';
          fly.style.top = targetRect.top + 'px';
          fly.style.width = targetRect.width + 'px';
          fly.style.height = targetRect.height + 'px';
        } else {
          fly.style.left = toLeft + 'px';
          fly.style.top = toTop + 'px';
        }
      };
      // 双 rAF 让浏览器先应用起点样式，再触发 transition
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(start));
      } else {
        start();
      }

      // 装备落地前 180ms 让飞牌开始淡出，与装备栏淡入形成「溶接」
      if (dest === 'equip' && typeof SGS.sleep === 'function') {
        SGS.sleep(340).then(() => {
          try { fly.classList.add('landing'); } catch (e) { /* 忽略 */ }
        });
      }

      return new Promise((resolve) => {
        setTimeout(() => {
          arrive();

          // ★ 原牌只在「摘不掉节点」的兜底分支里才需要恢复可见。
          //   正常路径已经把手牌里那张真节点摘掉了（predictHandDeparture），
          //   这里再去改 visibility 没有意义，反而会在客机上演成
          //   「飞牌落地 → 原位闪一下原牌 → 下一秒快照才把它删掉」。
          //   兜底分支也延后一轮 macrotask：那时调用方的 removeCard + render
          //   已经跑完，相同的 data-id 节点被复用 / 移除，恢复才不会露馅。
          if (hiddenFallback && handCardEl && handCardEl.style) {
            const node = handCardEl;
            setTimeout(() => {
              try { node.style.visibility = ''; } catch (e) { /* 节点已移除 */ }
            }, 0);
          }

          // ① 展示区真牌恢复可见（飞牌从头到尾就是它的替身，位置尺寸一致）
          if (showcaseCommitted) {
            try {
              showcaseCommitted.style.visibility = '';
              if (showcaseCommitted.classList) showcaseCommitted.classList.remove('enter');
            } catch (e) { /* 回合结束已清空展示区，忽略 */ }
          }

          // ② 装备落地：onArrive 已经 render / renderEquips 重建了装备栏，
          //    给新槽加一次淡入，避免「飞牌消失 → 文字硬蹦出来」。
          if (dest === 'equip' && opts.slot) {
            try {
              const tp = opts.toPlayer;
              let slotEl = null;
              if (tp && tp.isHuman) {
                slotEl = $('me-equip-' + opts.slot);
              } else if (typeof document.querySelector === 'function') {
                slotEl = document.querySelector(
                  '#ai-equips .eq-mini-row[data-slot="' + opts.slot + '"]');
              }
              if (slotEl && slotEl.classList) {
                slotEl.classList.remove('just-mounted');
                void slotEl.offsetWidth;   // 强制重排，连续装同一槽也能重播
                slotEl.classList.add('just-mounted');
                const node = slotEl;
                SGS.sleep(360).then(() => {
                  try { node.classList.remove('just-mounted'); } catch (e) { /* 已重绘 */ }
                });
              }
            } catch (e) { /* 无 DOM 环境忽略 */ }
          }

          try {
            if (fly.parentNode && fly.parentNode.removeChild) fly.parentNode.removeChild(fly);
            else app.removeChild(fly);
          } catch (e) { /* 已移除，忽略 */ }
          resolve();
        }, 520); // 略长于 .45s 过渡，落地时动画已播完
      });
    }

    /**
     * ★「插入手牌」通用动画（玩家自己摸牌 / 顺手牵羊获得牌共用）。
     *
     * 与旧版「一摞背面牌飞进来、落地才展开」不同，这里是真正把牌插进手牌区：
     *   ① FIRST  记下现有手牌每张的屏幕矩形（按 data-id 索引）
     *   ② commit 把新牌加进 player.hand（顺手牵羊由调用方提供，含区域移除）
     *   ③ render + layoutHand → 手牌重排，旧牌到达「该移动到的位置」
     *   ④ FLIP   旧牌先 translate 回旧位置，下一帧过渡回 0 → 平滑让位
     *   ⑤ 新牌真 DOM 先隐藏，用【正面】.fly-card 从 sourceRect 飞到它最终的格子
     *   ⑥ 落地   移除飞牌、显示真牌、清掉 FLIP 内联样式
     * 玩家自己获得牌一律「正面朝上」（不再用牌背）；AI 手牌不可见，不走本方法。
     * 真 DOM 在动画期间只是 visibility:hidden，落地即恢复，不影响点选。
     *
     * @returns {Promise<boolean>} true = 已完成 commit + 动画（调用方别再 push）
     */
    async flipInsertIntoHand(cards, player, game, opts) {
      opts = opts || {};
      const app = $('app');
      const handEl = $('me-hand');
      const canAnimate = app && handEl && game &&
        typeof app.appendChild === 'function' &&
        typeof app.getBoundingClientRect === 'function' &&
        typeof document.createElement === 'function' &&
        typeof document.querySelectorAll === 'function' &&
        typeof this.render === 'function';
      if (!canAnimate || !cards || !cards.length) return false;

      const R = (el) => el && typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect() : null;
      const list = () => {
        try {
          return Array.prototype.slice.call(
            document.querySelectorAll('#me-hand .card'));
        } catch (e) { return []; }
      };

      // ① FIRST：旧手牌位置
      const firstRects = {};
      list().forEach((el) => {
        const id = el.dataset && el.dataset.id;
        const r = R(el);
        if (id && r && r.width) {
          firstRects[id] = { left: r.left, top: r.top };
        }
      });

      // ② 新牌入场 + 重排（render 末尾已经调过 layoutHand）
      // ★ viewOnly：客机视图由权威快照驱动，状态已经同步好，绝不能在这里
      //   再次 push / render 改视图；只借用本方法的「隐藏真牌 + 从牌堆飞入
      //   最终格子」动画，于是手牌整理与飞牌在同一帧内完成。
      if (!opts.viewOnly) {
        if (typeof opts.commit === 'function') opts.commit();
        else cards.forEach((c) => player.hand.push(c));
      }
      // ★ 本方法下面自己做旧牌 FLIP 让位（还要配合隐藏新牌），
      //   临时抑制 render() 的自动 FLIP，避免同一批 DOM 被 invert 两次。
      if (!opts.viewOnly) {
        this._handFlipSuppress = true;
        try { this.render(game); } finally { this._handFlipSuppress = false; }
      }
      this.layoutHand(this.visibleHand(player.hand).length);

      const newIds = cards.map((c) => String(c.id));
      let after = list();
      const newEls = {};
      after.forEach((el) => {
        const id = el.dataset && el.dataset.id;
        if (id && newIds.indexOf(String(id)) >= 0) newEls[String(id)] = el;
      });
      // ★ viewOnly 的关键兜底：主机给远端摸牌时是【落地之后】才把牌入队，
      //   所以客机收到 fx 时快照里还没有这几张牌，手牌区自然也没有它们的
      //   真 DOM。没有节点就飞不了 —— 这正是「客机得牌飞牌消失」的根因。
      //   这里临时插一张同款预测节点当作替身，动画结束后留在原地等快照
      //   覆盖（syncHandDOM 按 data-id 会复用它），视觉上与主机完全一致。
      if (opts.viewOnly) {
        const missing = cards.filter((c) => !newEls[String(c.id)]);
        if (missing.length) {
          missing.forEach((c) => {
            const holder = document.createElement('div');
            holder.innerHTML = this.cardHTML(c);
            const node = holder.firstElementChild ||
              (holder.children && holder.children[0]) || holder.firstChild;
            if (!node) return;
            // ★ 绝对不要写 node.dataset = node.dataset || {}：
            //   dataset 只有 getter，而 class 方法体是严格模式，
            //   这一句会抛 TypeError，让整个 async 方法静默 reject ——
            //   表现就是「客机得牌完全没有飞牌动画」，且控制台只有一条
            //   没人 catch 的 Promise 拒绝。
            if (node.dataset) node.dataset.predict = '1';
            handEl.appendChild(node);
            newEls[String(c.id)] = node;
          });
          after = list();
          this.layoutHand(this.visibleHand(player.hand).length + missing.length);
        }
      }

      // ③ 起点：展示区中央（摸牌）或目标角色框（顺手牵羊）
      const sr = opts.sourceRect || R($('table-card')) || R(app);

      // ④ FLIP invert：旧牌平滑让位
      const movers = [];
      after.forEach((el) => {
        const id = el.dataset && el.dataset.id;
        const f = id && firstRects[id];
        if (!f || newIds.indexOf(String(id)) >= 0) return;   // 新牌不参与让位
        // ★ 正在飞行中的牌（visibility:hidden，等飞牌落地才恢复）不要参与让位：
        //   它是上一次 flyCard 刚插进来的预测节点，此刻完全看不见，做过渡纯属浪费；
        //   更糟的是它会带上本轮 invert 的 transform，导致「上一次飞牌起飞那一帧
        //   量到的落点 = 过渡中的旧坐标」，落地后再弹回真实格子（连摸两张时
        //   第一张会向左跳 ~70px）。隐藏节点直接跳过，让它按布局瞬移。
        if (el.style && el.style.visibility === 'hidden') return;
        const r = R(el);
        if (!r || !r.width) return;
        const dx = f.left - r.left, dy = f.top - r.top;
        if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        el.classList.add('flip-move');
        movers.push(el);
      });

      // ⑤ 新牌：正面克隆飞入自己的最终格子（逐张错开起飞）
      // ★ 量不到真牌矩形时（手牌区刚被清空 / 节点还没布局）按「接在末尾」
      //   估算落点，绝不 return —— 那会变成「客机得牌一张飞牌都没有」。
      const handRect = R(handEl) || { left: 0, top: 0, width: 0, height: 0 };
      let sample = null;
      try {
        sample = typeof document.querySelector === 'function'
          ? R(document.querySelector('#me-hand .card')) : null;
      } catch (e) { sample = null; }
      const fallbackW = (sample && sample.width) || (sr && sr.width) || 60;
      const fallbackH = (sample && sample.height) || (sr && sr.height) || 84;
      const flies = [];
      cards.forEach((c, i) => {
        const el = newEls[String(c.id)];
        const r = el ? R(el) : null;
        const target = (r && r.width && r.height)
          ? { left: r.left, top: r.top, width: r.width, height: r.height }
          : {
              left: this.handAppendX(fallbackW, handRect),
              top: handRect.top + (handRect.height - fallbackH) / 2,
              width: fallbackW, height: fallbackH
            };
        if (el && el.style) el.style.visibility = 'hidden';
        const fly = document.createElement('div');
        fly.className = 'fly-card drawing';
        fly.style.left = (sr.left + sr.width / 2 - target.width / 2) + 'px';
        fly.style.top = (sr.top + sr.height / 2 - target.height / 2) + 'px';
        fly.style.width = target.width + 'px';
        fly.style.height = target.height + 'px';
        fly.style.zIndex = String(21 + i);
        fly.innerHTML = this.cardHTML(c);      // ★ 正面朝上，不再用牌背
        app.appendChild(fly);
        flies.push({ fly, el, left: target.left, top: target.top,
          delay: (opts.delay || 0) + i * 110 });
      });

      // ⑥ 双 rAF：先让 invert / 起点样式落地，再一起播放
      const start = () => {
        movers.forEach((el) => {
          el.style.transition = 'transform .42s cubic-bezier(.22,.61,.36,1)';
          el.style.transform = 'translate(0,0)';
        });
        flies.forEach((rec) => {
          // ★ 终点（位置与尺寸）在真正起飞这一帧再量一次：客机连摸多张时，
          //   每张牌是一次独立的飞牌调用，后一张入队会让手牌整体重排
          //   （牌宽 / 格子都会变），用调用时量到的旧坐标就会「几张牌叠在
          //   一起再各自弹开」。这里以起飞瞬间的真实格子为准，尺寸变化交给
          //   .fly-card.moving 的 width / height 过渡平滑吃掉。
          if (rec.el && typeof rec.el.getBoundingClientRect === 'function') {
            const nr = rec.el.getBoundingClientRect();
            if (nr && nr.width) {
              rec.left = nr.left; rec.top = nr.top;
              if (nr.height) {
                rec.fly.style.width = nr.width + 'px';
                rec.fly.style.height = nr.height + 'px';
              }
            }
          }
          rec.fly.style.transitionDelay = rec.delay + 'ms';
          rec.fly.classList.add('moving');
          rec.fly.style.left = rec.left + 'px';
          rec.fly.style.top = rec.top + 'px';
        });
      };
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(() => { start(); resolve(); }));
        } else { start(); resolve(); }
      });

      await SGS.sleep((opts.delay || 0) + (cards.length - 1) * 110 + 520);

      // ⑦ 落地清理：真牌恢复、飞牌移除、FLIP 内联样式清空
      flies.forEach(({ fly, el }) => {
        try {
          if (fly.parentNode && fly.parentNode.removeChild) fly.parentNode.removeChild(fly);
          else app.removeChild(fly);
        } catch (e) { /* 已移除 */ }
        if (el) el.style.visibility = '';
      });
      movers.forEach((el) => {
        el.style.transition = '';
        el.style.transform = '';
        el.classList.remove('flip-move');
      });
      return true;
    }

    /**
     * 摸牌动画入口（Game.drawCards 调用，签名不变）。
     *  · 玩家自己摸牌 → flipInsertIntoHand：旧牌让位 + 新牌【正面】插入手牌区，
     *    内部已完成 push + render，返回 true 让 drawCards 不再重复入队。
     *  · AI 摸牌 → 手牌不可见，沿用「背面朝上飞向 AI 角色框」的旧动画，
     *    返回 false，牌仍由 drawCards 在 await 之后入队。
     *  · 无 DOM 动画能力（自测假界面）→ 返回 false，直接落地。
     *
     * @returns {Promise<boolean>} 是否已在内部完成入队
     */
    animateDraw(cards, player, game) {
      const app = $('app');
      const canAnimate = app && typeof app.appendChild === 'function' &&
        typeof app.getBoundingClientRect === 'function' &&
        typeof document.createElement === 'function';
      if (!canAnimate || !cards || !cards.length) return Promise.resolve(false);
      if (player && player.isHuman && game &&
          typeof this.flipInsertIntoHand === 'function') {
        const R = (el) => el && typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect() : null;
        return this.flipInsertIntoHand(cards, player, game, {
          sourceRect: R($('table-card')) || R(app),
          commit: () => cards.forEach((c) => player.hand.push(c))
        });
      }
      return this.animateDrawToAI(cards, player, game).then(() => false);
    }

    /**
     * AI 摸牌：牌从展示区「背面朝上」叠放飞向 AI 角色框右端（代表不可见手牌）。
     * 一次多张时落点依次递进 1/3 卡宽（后一张盖住前一张 2/3），
     * transition-delay 逐张错开起飞。牌由 Game.drawCards 在本方法返回后入队。
     */
    animateDrawToAI(cards, player, game) {
      const app = $('app');
      const canAnimate = app && typeof app.appendChild === 'function' &&
        typeof app.getBoundingClientRect === 'function' &&
        typeof document.createElement === 'function';
      if (!canAnimate || !cards || !cards.length) return Promise.resolve();

      const R = (el) => el && typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect() : null;
      const src = R($('table-card')) || R(app);           // 起点：展示区中央
      const destEl = player && player.isHuman
        ? ($('me-hand') || $('me-area'))
        : $('ai-area');                                   // AI 用角色框代表手牌
      const dest = R(destEl) || R(app);
      if (!src || !src.width || !dest || !dest.width) return Promise.resolve();

      // 卡牌尺寸：优先量取手牌区里真实的卡，否则按 7:5 从目标区高度推导
      let w, h, sample = null;
      try {
        if (typeof document.querySelector === 'function' && player && player.isHuman) {
          sample = R(document.querySelector('#me-hand .card'));
        }
      } catch (e) { sample = null; }
      if (sample && sample.width > 10) {
        w = sample.width; h = sample.height;
      } else {
        h = Math.max(48, Math.min(dest.height * 0.8, 110));
        w = h * 5 / 7;
      }

      const n = cards.length;
      const step = w / 3;                                   // 露出 1/3 → 盖住 2/3
      // ★ 落点：玩家摸牌接在「手牌区最右边那张牌的右边」（与顺手牵羊同一位置）；
      //   AI 没有独立手牌区，仍以其角色框右端代表手牌末尾。
      const baseLeft = player && player.isHuman
        ? this.handAppendX(w, dest)
        : dest.left + dest.width - w - (n - 1) * step;
      const top = dest.top + (dest.height - h) / 2;
      const startLeft = src.left + src.width / 2 - w / 2;
      const startTop = src.top + src.height / 2 - h / 2;
      const back = this.cardBackHTML();                     // 全部背面朝上

      const flies = cards.map((c, i) => {
        const fly = document.createElement('div');
        fly.className = 'fly-card drawing';
        fly.style.left = startLeft + 'px';
        fly.style.top = startTop + 'px';
        fly.style.width = w + 'px';
        fly.style.height = h + 'px';
        fly.style.zIndex = String(21 + i);                  // 后一张盖住前一张
        fly.innerHTML = back;
        app.appendChild(fly);
        return { fly, left: baseLeft + i * step, top: top, delay: i * 110 };
      });

      const start = () => {
        flies.forEach((rec) => {
          // inline longhand 覆盖 .moving 简写里的 transition-delay:0
          rec.fly.style.transitionDelay = rec.delay + 'ms';
          rec.fly.classList.add('moving');
          rec.fly.style.left = rec.left + 'px';
          rec.fly.style.top = rec.top + 'px';
        });
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(start));
      } else {
        start();
      }

      // 最后一张的延迟 + .45s 过渡 + 余量
      return SGS.sleep((n - 1) * 110 + 520).then(() => {
        flies.forEach(({ fly }) => {
          try {
            if (fly.parentNode && fly.parentNode.removeChild) fly.parentNode.removeChild(fly);
            else app.removeChild(fly);
          } catch (e) { /* 已移除，忽略 */ }
        });
      });
    }

    /* ---------------- 日志 ---------------- */

    log(msg, cls) {
      // ★ 技能发动动画：从「XX 发动【技能】」日志里兜底识别，统一播横幅
      try { this.maybeSkillFX(msg, cls); } catch (e) { /* 动画不影响日志 */ }
      const line = document.createElement('div');
      line.className = 'line ' + (cls || '');
      line.textContent = msg;
      const box = $('log');
      box.appendChild(line);
      while (box.children.length > 200) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
      // ★ 联机钩子：把牌局记录同步给客机（客机自己不设此钩子）
      if (this.onLog) { try { this.onLog(msg, cls); } catch (e) {} }
    }

    /* ---------------- 操作按钮 ---------------- */

    /**
     * list: [{ label, cls, disabled, onClick, slot }]
     * slot === 'skill' 的按钮进入右下技能按钮位（裸按钮），其余进入手牌上方操作区。
     * ★ 技能位没有按钮时，补该角色「全部技能」的灰色占位（skillNamesOf 口径），
     *   而不是只补一个场景短名 —— 摸牌 / 出牌飞牌 / 结算动画期间 pending 为 null，
     *   refreshActions() 会走这里，之前只显示「火计」一个按钮就是这么来的。
     *   opts.noSkillPlaceholder 为 true 时留空（调用方已用 pushSkillButtons
     *   显式给出全部按钮，不需要再补一遍）。
     */
    setActions(list, opts) {
      opts = opts || {};
      const box = $('actions');
      const skillBox = $('skill-actions');
      box.innerHTML = '';
      skillBox.innerHTML = '';
      (list || []).forEach((item) => {
        const b = document.createElement('button');
        b.className = 'btn ' + (item.cls || '');
        b.textContent = item.label;
        b.disabled = !!item.disabled;
        if (item.onClick) b.addEventListener('click', item.onClick);
        (item.slot === 'skill' ? skillBox : box).appendChild(b);
      });
      // ★ 技能按钮尺寸与数量无关：全部继承 .btn 默认样式，多个技能只是
      //   在角色框左侧那一列依次竖排，不再按数量切换收紧样式。

      if (!opts.noSkillPlaceholder && skillBox.children.length === 0 && this.game && this.game.human) {
        // ★ 动画 / 等待 / 开局：pending 为 null 时也要列出该角色的全部技能，
        //   全部 disabled + skill-off 灰色占位，与操作界面同一套显示口径。
        skillNamesOf(this.game.human).forEach((name) => {
          const b = document.createElement('button');
          b.className = 'btn skill skill-off';
          b.textContent = name;
          b.disabled = true;
          skillBox.appendChild(b);
        });
      }
    }

    /** 根据 pending 状态刷新按钮区 */
    refreshActions() {
      const pd = this.pending;
      if (!pd) {
        // ★ 动画期间（摸牌 / 出牌飞牌 / 展示区让位）pending 已清空：
        //   操作区显示「等待中…」，右下技能栏仍由 setActions 列出全部技能灰占位，
        //   不会再退回成「只有一个技能」的旧占位。
        this.setActions([{ label: '等待中…', disabled: true }]);
        return;
      }

      if (pd.mode === 'play') {
        const card = pd.player.hand.find((c) => c.id === pd.selected);
        // 普通出牌只认牌面：杀 / 桃 / 酒 / 锦囊 / 装备可直接用；闪必须走技能按钮转化。
        // 锦囊的目标与距离合法性由 game.js → tricks.js 在点击「使用」后校验。
        // ★【使用】按钮在点击之前就判断可用性，不再「点了才回退」：
        //   杀次数用完 / 本回合已用酒 / 体力已满时用桃，按钮直接变灰。
        //   全部实时读角色钩子与状态，装备变化或回血后会自动恢复。
        const shaOk = card && SGS.Cards.isSha(card.type) ? pd.player.canPlaySha() : true;
        const jiuOk = card && card.type === 'jiu' ? !pd.player.jiuUsed : true;
        const taoOk = card && card.type === 'tao'
          ? pd.player.hp < pd.player.maxHp : true;
        // ★【无懈可击】是响应专用锦囊：只有存在正在结算、可被抵消的
        //   目标锦囊牌时才能打出。出牌阶段没有目标锦囊牌 → 【使用】按钮
        //   直接灰掉，不再「点了才回退」。技能按钮（如【渐营】把这张牌
        //   当基本牌）由 pushSkillButtons 独立判断，不受这里影响。
        const wuxieOk = isResponseOnly(card) ? hasWuXieTarget(pd) : true;
        const basicUsable = !!card && shaOk && jiuOk && taoOk && wuxieOk && (
          SGS.Cards.isSha(card.type) || card.type === 'tao' || card.type === 'jiu' ||
          SGS.Cards.isTrick(card.type) || SGS.Cards.isEquip(card.type)
        );
        const list = [
          {
            label: card ? '使用【' + card.name + '】' : '使用选中牌',
            cls: 'primary',
            disabled: !basicUsable,
            onClick: () => this.finish({ type: 'use', card: card })
          }
        ];
        // ★【铁索连环】重铸：弃置此牌并摸一张牌，不算使用它
        if (card && card.type === 'tiesuolianhuan') {
          list.push({
            label: '重铸【铁索连环】',
            onClick: () => this.finish({ type: 'reforge', card: card })
          });
        } else if (card && pd.player) {
          // ★【连环】：♣ 牌可直接当【铁索连环】重铸（装备区素材另走技能按钮）
          const cv = ((pd.player.skill && pd.player.skill.conversions) || []).find((c) =>
            c.reforge && c.to === 'tiesuolianhuan' &&
            (c.scenes || ['play']).indexOf('play') >= 0 &&
            SGS.Cards.matchesFrom(card, c.from) &&
            typeof pd.player.canUseAsType === 'function' &&
            pd.player.canUseAsType(card, c.to)
          );
          if (cv) {
            list.push({
              label: '重铸【铁索连环】',
              onClick: () => this.finish({
                type: 'reforge', card: card, viaSkill: true,
                conversion: cv, scene: 'play'
              })
            });
          }
        }
        // ★ 全部技能按钮：可发动的可点，被动 / 条件不满足的灰色占位
        pushSkillButtons(list, this, pd, 'play', null);
        list.push({ label: '结束出牌', onClick: () => this.finish({ type: 'end' }) });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'respond') {
        // ★ 不再先弹「是否使用闪」：一进入就直接可选手牌，点【使用【X】】确认。
        //   need 由发起方决定：杀/万箭齐发要【闪】，南蛮入侵/决斗要【杀】。
        const need = pd.respondNeed || 'shan';
        const needName = SGS.Cards.nameOf(need);
        const list = [
          {
            label: respondAction(need),
            cls: 'primary',
            disabled: !pd.selected,
            onClick: () => this.confirmRespond()
          }
        ];
        pushSkillButtons(list, this, pd, 'respond', need);
        list.push({ label: '不出【' + needName + '】', onClick: () => this.finish(null) });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'target' || pd.mode === 'targets') {
        // ★ 选目标期间技能不能中途发动，但全部技能按钮仍完整展示（灰色占位）
        const list = [{ label: '取消选择目标', onClick: () => this.finish(null) }];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'trick') {
        // ★ 提示只保留目标牌区面板里那一条（#tp-hint）：面板自己会用
        //   pd.customHint 覆盖默认文案，操作区不再重复放一条灰色说明按钮。
        //   确认按钮仍在面板内部。
        const list = [];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'wugu') {
        // 五谷丰登：选牌面板里点一下即取，操作区只放提示
        const list = [{ label: '【五谷丰登】请在上方点选一张牌', disabled: true }];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'peek') {
        // ★【火计·火攻】：查看目标手牌，选一张展示；确认按钮与【使用牌】
        //   同处手牌上方操作区，右下仍完整列出全部技能（此刻全为灰色占位）。
        const list = [
          {
            label: pd.selected ? '展示所选牌' : '请点选一张牌展示',
            cls: 'primary', disabled: !pd.selected,
            onClick: () => this.confirmPeek()
          },
          { label: '取消', onClick: () => this.finish(null) }
        ];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'chainTargets') {
        // 铁索连环：目标可逐个点选，选够 1 名后即可确认
        const n = (pd.picked || []).length;
        const list = [
          {
            label: '确认（' + n + '/' + pd.min + '~' + pd.max + '）',
            cls: 'primary',
            disabled: n < (pd.min || 1),
            onClick: () => this.confirmChainTargets()
          },
          { label: '取消', onClick: () => this.finish(null) }
        ];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'wuxie') {
        // ★ 无懈可击：目标数 >=2 的锦囊才提供第三个「本轮不使用」按钮，
        //   避免单体锦囊多一个毫无用处的选项。
        // ★ 手里连一张真【无懈可击】都没有时，这个按钮也直接灰掉
        //   （点进去只会打开一个空选牌界面）；技能转化按钮由
        //   pushSkillButtons 独立判断，【龙魂】♠ /【看破】黑牌仍可点。
        const hasRealWuXie = (pd.player.hand || [])
          .some((c) => c.type === 'wuxiekeji');
        const actions = [{
          label: '使用【无懈可击】', cls: 'primary',
          disabled: !hasRealWuXie,
          onClick: () => this.pickWuXieCard()
        }, { label: '不使用', onClick: () => this.finish(null) }];
        if (pd.allowOptOut) {
          actions.push({ label: '本轮不使用无懈可击', onClick: () => this.finish('optOut') });
        }
        // ★【龙魂】♠ /【看破】黑牌当【无懈可击】：与「使用【无懈可击】」
        //   并列；其余技能（火计 / 八阵…）在此场景一律灰色占位。
        pushSkillButtons(actions, this, pd, 'wuxie', 'wuxiekeji');
        this.setActions(actions, { noSkillPlaceholder: true });

      } else if (pd.mode === 'choice') {
        // ★ 二选一（如【雌雄双股剑】由目标选「弃手牌 / 令对方摸牌」）
        //   按钮一次性构造，避免多次 setActions 相互清空。
        const list = (pd.choices || []).map((c, i) => ({
          label: c.label,
          cls: i === 0 ? 'primary' : '',
          onClick: () => this.finish(c.value)
        }));
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'optional') {
        // 「可以」类装备技能：询问是否发动，两个按钮都在手牌上方操作区。
        // 右下仍完整列出全部技能，但此刻不能中途发动，统一灰色占位。
        const list = [
          {
            label: pd.yes || ('发动【' + pd.optName + '】'),
            cls: 'primary',
            onClick: () => this.finish(true)
          },
          { label: pd.no || '不发动', onClick: () => this.finish(false) }
        ];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'zhangba') {
        // 【丈八蛇矛】：确认按钮与正常使用牌同处手牌上方操作区。
        // 出牌阶段当【杀】使用要看次数；响应阶段只是「打出」杀，不受限。
        const zbShaOk = pd.zhangbaScene === 'play' ? pd.player.canPlaySha() : true;
        const list = [
          {
            label: '丈八蛇矛',
            cls: 'primary',
            disabled: pd.selected.length !== 2 || !zbShaOk,
            onClick: () => this.confirmZhangba()
          },
          { label: '取消', onClick: () => this.cancelZhangba() }
        ];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'skill') {
        const conv = pd.conversion;
        // ★ 转化的【杀】同样受出杀次数限制、【桃】满血不可用：
        //   与出牌阶段【使用】按钮共用同一套判断，避免「点进去确认时才被拒」。
        //   响应 / 无懈场景打出的【杀】不算「使用」，不受次数限制。
        const usable = conversionUsable(pd.player, conv, pd.scene, !!pd.noShaCount);
        // 确认发动与「使用【杀】」同处手牌上方操作区；右下仍完整展示
        // 全部技能，但这次转化进行中不能中途改发动，统一灰色占位。
        const list = [
          {
            label: pd.skillName || skillButtonName(pd.skill, pd.scene),
            cls: 'primary',
            disabled: !usable,
            onClick: () => this.confirmSkill()
          }
        ];
        // ★【连环】♣ 牌（含装备区的牌）当【铁索连环】重铸
        if (usable && conv && conv.reforge && conv.to === 'tiesuolianhuan' && pd.card) {
          list.push({
            label: '重铸【铁索连环】',
            onClick: () => this.finish({
              type: 'reforge', card: pd.card, viaSkill: true,
              conversion: conv, scene: pd.scene
            })
          });
        }
        list.push({ label: '取消', onClick: () => this.cancelSkill() });
        pushSkillButtons(list, this, pd, pd.scene, pd.respondNeed,
          { forceDisabled: true, noShaCount: !!pd.noShaCount });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'discard') {
        const list = [
          {
            label: '确认弃牌（' + pd.selected.length + '/' + pd.need + '）',
            cls: 'primary',
            disabled: pd.selected.length !== pd.need,
            onClick: () => this.finish(pd.selected.slice())
          }
        ];
        pushSkillButtons(list, this, pd, 'play', null, { forceDisabled: true });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'pick') {
        // ★ 手牌区默认选牌：确认 / 取消按钮与出牌、弃牌同在手牌上方操作区。
        //   allowEquip 时装备区点击也算入总数；结算顺序 = 手牌点击顺序 → 装备点击顺序。
        const equipIds = pd.allowEquip && Array.isArray(pd.equipSelected)
          ? pd.equipSelected.slice() : [];
        const count = pd.selected.length + equipIds.length;
        const list = [{
          label: (pd.confirmLabel || '确认') +
            (pd.need > 1 ? '（' + count + '/' + pd.need + '）' : ''),
          cls: 'primary',
          disabled: count !== pd.need,
          onClick: () => {
            const ids = pd.selected.slice().concat(equipIds);
            this.finish(pd.need === 1 ? (ids[0] || null) : ids);
          }
        }];
        if (pd.cancelLabel) {
          list.push({ label: pd.cancelLabel, onClick: () => this.finish(null) });
        }
        // ★ 全部技能按钮：青龙偃月刀追加杀界面按 qinglong 场景判断
        //   （龙魂 ♦→火杀、龙胆 闪→杀、渐营 当基本牌…可点，其余灰色占位）；
        //   其它普通选牌界面（火攻 / 贯石斧等）不能中途发动技能，全部灰色占位。
        //   始终 noSkillPlaceholder，避免额外补一个同名禁用占位。
        pushSkillButtons(list, this, pd,
          pd.skillScene || 'play', pd.skillNeed || null,
          { forceDisabled: !pd.skillNeed, noShaCount: !!pd.skillNoShaCount });
        this.setActions(list, { noSkillPlaceholder: true });

      } else if (pd.mode === 'brink') {
        // ★ 濒死时不再自动替玩家挑第一张：手里有多张【桃】/【酒】时，
        //   由玩家在手牌区点选具体哪一张，再点【使用】确认自救。
        //   酒在这里不受「每回合限一次」约束（由 game.brink 循环处理）。
        const saves = pd.saves || (pd.tao ? [pd.tao] : []);
        const chosen = saves.find((c) => c.id === pd.selected) || null;
        const list = [{
          label: chosen ? '使用【' + chosen.name + '】自救' : '使用选中的【桃】/【酒】自救',
          cls: 'primary',
          disabled: !chosen,
          onClick: () => { if (chosen) this.finish(chosen); }
        }];
        // ★【龙魂】♥ 当【桃】：濒死时同样必须点技能按钮发动，
        //   不混进普通【桃】/【酒】的选牌里；其余技能灰色占位。
        pushSkillButtons(list, this, pd, 'brink', 'tao');
        list.push({ label: '放弃', onClick: () => this.finish(null) });
        this.setActions(list, { noSkillPlaceholder: true });
      }
    }

    /* ---------------- 「可以」类主动技能按钮 ---------------- */

    /**
     * ★ 一次性主动技按钮（当前只有【涅槃】）：不进入选牌转化流程，
     * 直接把 {type:'skillAction'} 回传给 Game（出牌阶段 / 濒死都走同一个
     * 入口）。规则层会复核场景与「每局一次」，重复点击不会再生效。
     */
    invokeSkillAction(pd, scene, name) {
      if (!pd || !pd.player) return;
      if (!SGS.canUseSkillAction(pd.player, name, scene)) return;
      this.finish({ type: 'skillAction', name: name, scene: scene });
    }

    /** ① 点技能按钮：进入「选牌 → 转化」流程。skillName 是点的那一个技能 */
    openSkill(pd, scene, skillName) {
      const skill = activeSkill(pd.player);
      if (!skill) return;
      pd.skillName = skillName || skillButtonName(skill, scene);
      pd.prevMode = pd.mode;
      pd.prevSelected = pd.selected;
      pd.scene = scene;
      // ★ 出牌阶段不按牌型过滤，列出该角色全部主动转化方向
      //   （龙魂 杀/桃、火计 火攻、渐营 任意基本牌…）；响应按本次索要的牌过滤；
      //   濒死固定要【桃】，无懈响应固定要【无懈可击】。
      // ★ play 场景保留外部已设的 respondNeed（青龙追加杀是 ['sha','basic']），
      //   普通出牌阶段没有这个字段，仍为 null（列出全部主动转化方向）。
      pd.respondNeed = scene === 'play' ? (pd.respondNeed || null)
        : scene === 'brink' ? 'tao'
        : scene === 'wuxie' ? 'wuxiekeji'
        : (pd.respondNeed || 'shan');
      pd.noShaCount = !!pd.skillNoShaCount;
      pd.skill = skill;
      pd.mode = 'skill';
      pd.selected = null;
      pd.card = null;
      pd.conversion = null;

      // 可转化的牌在技能选牌模式下会高亮、其余置灰；引导里列出全部方向，
      // 【龙魂】这类按花色多方向转化的技能也能一眼看懂该选哪张牌。
      const dirs = conversionsFor(pd.player, scene, pd.respondNeed, pd.skillName);
      const dirText = dirs
        .map((c) => c.label || ('当【' + SGS.Cards.nameOf(c.to) + '】'))
        .join(' / ');
      const btnName = pd.skillName || skillButtonName(skill, scene);
      this.setHint('点选一张牌（手牌或装备区）发动【' + btnName + '】' +
        (dirText ? '（' + dirText + '）' : '') +
        '，再点上方操作区的【' + btnName + '】确认。');
      this.refreshActions();
      this.render(pd.game);
    }

    /** ③ 确认发动：按场景回传给主循环 */
    confirmSkill() {
      const pd = this.pending;
      if (!pd || !pd.conversion || !pd.card) return;
      // ★ 与按钮置灰同一套口径再复核一次（出杀次数 / 满血桃）
      if (!conversionUsable(pd.player, pd.conversion, pd.scene, !!pd.noShaCount)) {
        this.log('这张牌当前不能发动该转化。', 'warn');
        this.refreshActions();
        return;
      }
      const payload = {
        card: pd.card,
        viaSkill: true,
        conversion: pd.conversion,
        scene: pd.scene
      };
      this.finish(pd.scene === 'play' ? Object.assign({ type: 'use' }, payload) : payload);
    }

    /** 取消：回到进入技能按钮之前的交互状态 */
    cancelSkill() {
      const pd = this.pending;
      if (!pd) return;
      pd.mode = pd.prevMode;
      pd.selected = pd.prevSelected;
      pd.conversion = null;
      pd.card = null;
      let hint;
      if (pd.mode === 'respond') {
        hint = respondHint(pd.player, pd.respondNeed, pd.respondReason, pd.selected);
      } else if (pd.mode === 'brink') {
        hint = '你已濒死！点选真【桃】/【酒】，或点技能按钮用手牌/装备区的「牌」转化当【桃】。';
      } else if (pd.mode === 'wuxie') {
        // 取消技能选牌后恢复外层那条明确的无懈链提示，不退回笼统文案
        hint = pd.hintText ||
          '【无懈可击】：使用【无懈可击】，或点技能按钮用其他牌当【无懈可击】。';
      } else if (pd.mode === 'pick' && pd.hintText) {
        // ★ 从【青龙偃月刀】选牌界面点技能再取消：回到那条追加杀引导，
        //   不要错误地显示「出牌阶段」或「响应」文案。
        hint = pd.hintText;
      } else {
        hint = '出牌阶段：点选手牌 → 【使用】；或点【结束出牌】。';
      }
      this.setHint(hint);
      this.refreshActions();
      this.render(pd.game);
    }

    /* ---------------- 【丈八蛇矛】主动转化（点装备区武器栏触发） ---------------- */

    /**
     * 装备栏点击分发：
     *   · 技能选牌模式 → 把该槽的装备牌选作「牌」转化素材（见下方分支）
     *   · 多选模式（贯石斧等）→ 参与手牌 + 装备区混合选取
     *   · 装着【丈八蛇矛】且出牌 / 被索要【杀】→ 进入两张手牌的转化流程
     */
    onEquipSlotClick(slotKey) {
      const pd = this.pending;
      if (!pd || !pd.game) return;

      // ★「牌」= 手牌 + 装备区：技能选牌模式下点装备栏，把已装上的牌
      //   选为转化素材（【龙魂】/【渐营】/【火计】/【看破】等）。
      //   与点手牌完全一致：再点一次取消，确认按钮在上方操作区。
      if (pd.mode === 'skill' && pd.player === pd.game.human) {
        const card = pd.player.equips && pd.player.equips[slotKey];
        if (!card) return;
        const conv = findConversion(pd.player, card, pd.scene, pd.respondNeed, pd.skillName);
        if (!conv) {
          this.log('这张装备牌不能用于当前转化。', 'warn');
          return;
        }
        if (pd.card && pd.card.id === card.id) {
          pd.card = null; pd.conversion = null;
        } else {
          pd.card = card; pd.conversion = conv; pd.justPicked = card.id;
        }
        this.refreshActions();
        this.render(pd.game);
        return;
      }

      // ★ 贯石斧：手牌 + 装备区多选时，装备栏直接参与选取
      if (pd.mode === 'pick' && pd.allowEquip && pd.player === pd.game.human) {
        const card = pd.player.equips && pd.player.equips[slotKey];
        if (!card) return;
        const arr = Array.isArray(pd.equipSelected) ? pd.equipSelected : [];
        const i = arr.indexOf(card.id);
        const total = pd.selected.length + arr.length;
        if (i >= 0) arr.splice(i, 1);
        else if (total < pd.need) {
          arr.push(card.id);
          if (pd.need === 1) pd.selected = [];
        } else { this.log('最多只能选 ' + pd.need + ' 张。', 'warn'); return; }
        pd.equipSelected = arr;
        pd.justPicked = card.id;
        this.refreshActions();
        this.render(pd.game);
        return;
      }

      if (slotKey !== 'weapon') return;
      const me = pd.player;
      if (!me || !SGS.Equipment || !SGS.Equipment.hasZhangba(me)) return;
      if (!(pd.mode === 'play' ||
            (pd.mode === 'respond' && pd.respondNeed === 'sha'))) return;
      if (me.hand.length < 2) {
        this.log('【丈八蛇矛】需要至少两张手牌。', 'warn');
        return;
      }
      if (pd.mode === 'play' && !me.canPlaySha()) {
        this.log('本回合【杀】的使用次数已用完。', 'warn');
        return;
      }
      this.openZhangba(pd, pd.mode === 'play' ? 'play' : 'respond');
    }

    /** 进入「选两张手牌当【杀】」模式，沿用统一 sel / picked 上浮动画 */
    openZhangba(pd, scene) {
      pd.prevMode = pd.mode;
      pd.prevSelected = pd.selected;
      pd.zhangbaScene = scene;
      pd.mode = 'zhangba';
      pd.selected = [];
      pd.justPicked = null;
      this.setHint('【丈八蛇矛】：点选两张手牌当【杀】' +
        (scene === 'play' ? '使用' : '打出') +
        '，再点上方操作区的【丈八蛇矛】确认。');
      this.refreshActions();
      this.render(pd.game);
    }

    /** 确认发动：出牌阶段回传 {type:'use', zhangba:true, cards}，响应阶段回传响应对象 */
    confirmZhangba() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'zhangba' || pd.selected.length !== 2) return;
      const cards = pd.selected
        .map((id) => pd.player.hand.find((c) => c.id === id))
        .filter(Boolean);
      if (cards.length !== 2) return;
      this.finish(pd.zhangbaScene === 'play'
        ? { type: 'use', zhangba: true, cards: cards }
        : { zhangba: true, cards: cards, viaSkill: true, scene: 'respond' });
    }

    /** 取消：回到进入前的 play / respond 状态 */
    cancelZhangba() {
      const pd = this.pending;
      if (!pd) return;
      pd.mode = pd.prevMode;
      pd.selected = pd.prevSelected || null;
      pd.justPicked = null;
      this.setHint(pd.mode === 'respond'
        ? respondHint(pd.player, pd.respondNeed, pd.respondReason, pd.selected)
        : '出牌阶段：点选手牌 → 【使用】；或点【结束出牌】。');
      this.refreshActions();
      this.render(pd.game);
    }

    /* ---------------- 手牌点击分发 ---------------- */

    onCardClick(id) {
      const pd = this.pending;
      // 目标选择 / 目标牌区选牌时，玩家自己的手牌不参与交互
      if (!pd || pd.mode === 'target' || pd.mode === 'targets' ||
          pd.mode === 'trick' || pd.mode === 'wugu' || pd.mode === 'peek' ||
          pd.mode === 'chainTargets' || pd.mode === 'choice') return;
      const card = pd.player.hand.find((c) => c.id === id);
      if (!card) return;

      if (pd.mode === 'play') {
        pd.selected = pd.selected === id ? null : id;
        const skill = activeSkill(pd.player);
        if (card.type === 'shan') {
          this.setHint(skill
            ? '【闪】不能在出牌阶段直接使用；可点右下的【' +
              (SGS.skillNameFor(pd.player, 'play') || skill.name) + '】按技能规则转化。'
            : '【闪】只能在响应【杀】等需要【闪】的牌时打出。');
        } else if (card.type === 'tao') {
          this.setHint(pd.player.hp >= pd.player.maxHp
            ? '体力已满，不能使用【桃】，【使用】按钮已置灰。'
            : '【桃】：回复 1 点体力，点【使用】发动。');
        } else if (card.type === 'jiu') {
          this.setHint(pd.player.jiuUsed
            ? '本回合已经用过【酒】，不能再使用。'
            : '【酒】：本回合下一张【杀】伤害 +1，每回合限一次；濒死时可用它自救（次数不限）。');
        } else if (SGS.Cards.isSha(card.type)) {
          this.setHint(card.type === 'sha'
            ? (pd.player.canPlaySha()
                ? '【杀】：点【使用】后点击目标角色；本回合默认限用 1 次。'
                : '本回合【杀】的使用次数已用完，【使用】按钮已置灰。')
            : '【' + card.name + '】：' + SGS.Cards.defs[card.type].desc +
              ' 点【使用】后点击目标角色，同样消耗本回合出杀次数。');
        } else if (isResponseOnly(card)) {
          this.setHint('【无懈可击】只能在目标锦囊牌生效前作为响应打出；' +
            '当前没有可抵消的目标锦囊牌，【使用】按钮已置灰。' +
            '等有无懈询问时再使用，或点技能按钮把它当别的牌转化。');
        } else if (SGS.Cards.isTrick(card.type)) {
          this.setHint('【' + card.name + '】：' + SGS.Cards.defs[card.type].desc + ' 点【使用】发动。');
        } else if (SGS.Cards.isEquip(card.type)) {
          const slot = SGS.Equipment.slotOf(card);
          const label = (SGS.EQUIP_SLOTS.find((s) => s.key === slot) || {}).label || '装备区';
          const old = pd.player.equips && pd.player.equips[slot];
          this.setHint('【' + card.name + '】：' + SGS.Cards.defs[card.type].desc +
            ' 点【使用】装到左侧【' + label + '】栏' +
            (old ? '（替换【' + old.name + '】）' : '') + '。');
        } else {
          this.setHint('出牌阶段：点选手牌 → 【使用】；或点【结束出牌】。');
        }
        this.render(pd.game);
        this.refreshActions();

      } else if (pd.mode === 'skill') {
        // ② 选牌：只有符合当前场景转化方向（按 need）、且角色钩子允许的牌才能选中
        const conv = findConversion(pd.player, card, pd.scene, pd.respondNeed, pd.skillName);
        if (!conv) {
          this.log('这张牌不能用于【' +
            (SGS.skillNameFor(pd.player, pd.scene) || pd.skill.name) +
            '】在当前场景的转化。', 'warn');
          return;
        }
        pd.card = card;
        pd.conversion = conv;
        pd.selected = card.id;
        this.setHint('已选【' + card.name + '】，点上方操作区的【' +
          (SGS.skillNameFor(pd.player, pd.scene) || pd.skill.name) + '】确认发动。');
        this.render(pd.game);
        this.refreshActions();

      } else if (pd.mode === 'respond') {
        // ★ 被【杀】/【万箭齐发】指定后直接进入选牌：点一张 need 牌只选中
        //   （统一上浮动画），再点【使用【X】】确认。用别的牌当 need 牌
        //   仍必须走右下技能按钮（龙胆按 need 自动挑转化方向）。
        const need = pd.respondNeed || 'shan';
        const needName = SGS.Cards.nameOf(need);
        if (!SGS.Cards.matchesRespond(card, need)) {
          const skill = activeSkill(pd.player);
          this.log(skill
            ? '普通响应只能打出真正的【' + needName + '】；用其他牌当【' + needName +
              '】请点右下的【' +
              (SGS.skillNameFor(pd.player, 'respond') || skill.name) + '】。'
            : '普通响应只能打出真正的【' + needName + '】。', 'warn');
          return;
        }
        pd.selected = pd.selected === id ? null : id;
        this.setHint(respondHint(pd.player, need, pd.respondReason, pd.selected));
        this.render(pd.game);
        this.refreshActions();

      } else if (pd.mode === 'zhangba') {
        // ★ 与弃牌一致的统一选牌交互：点新牌加选（最多 2 张）、点已选牌减选，
        //   选满后不自动换选，只提示上限。sel / picked 动画与其它选牌完全相同。
        const i = pd.selected.indexOf(id);
        if (i >= 0) {
          pd.selected.splice(i, 1);
        } else if (pd.selected.length < 2) {
          pd.selected.push(id);
        } else {
          this.log('最多只能选 2 张手牌。', 'warn');
        }
        this.render(pd.game);
        this.refreshActions();

      } else if (pd.mode === 'discard') {
        const i = pd.selected.indexOf(id);
        if (i >= 0) {
          // 再点已选中的牌 → 取消选择（减选）
          pd.selected.splice(i, 1);
        } else if (pd.selected.length < pd.need) {
          pd.selected.push(id);
        } else {
          // 已选满：不自动换选，提示上限。要换牌需先点已选中的牌取消。
          this.log('最多只能选 ' + pd.need + ' 张。', 'warn');
        }
        this.render(pd.game);
        this.refreshActions();

      } else if (pd.mode === 'brink') {
        // ★ 濒死选牌：只能点【桃】/【酒】，与出牌 / 响应 / 弃牌共用
        //   sel + picked 上浮动画；点已选牌取消，确认按钮在上方操作区。
        const saves = pd.saves || [];
        if (!saves.some((c) => c.id === id)) {
          this.log('濒死时只能使用【桃】或【酒】自救。', 'warn');
          return;
        }
        pd.selected = pd.selected === id ? null : id;
        const chosen = saves.find((c) => c.id === pd.selected);
        this.setHint(chosen
          ? '已选【' + chosen.name + '】，点上方操作区的【使用】确认自救。'
          : '你已濒死！点选真【桃】/【酒】，或点技能按钮用手牌/装备区的「牌」转化当【桃】。');
        this.render(pd.game);
        this.refreshActions();

      } else if (pd.mode === 'pick') {
        // ★ 通用「从自己手牌区点一张」：与出牌 / 弃牌共用同一套 sel / picked
        //   上浮动画。火攻展示手牌、弃同花色牌都走这里，不再弹目标牌区面板。
        if (pd.pickFilter && !pd.pickFilter(card)) {
          this.log(pd.rejectHint || '这张牌不能用于当前选择。', 'warn');
          return;
        }
        const equipCount = pd.allowEquip && Array.isArray(pd.equipSelected)
          ? pd.equipSelected.length : 0;
        const i = pd.selected.indexOf(id);
        if (i >= 0) {
          pd.selected.splice(i, 1);
        } else if (pd.need === 1) {
          pd.selected = [id];   // 单选：点另一张直接换选
          if (pd.allowEquip) pd.equipSelected = [];
        } else if (pd.selected.length + equipCount < pd.need) {
          pd.selected.push(id);
        } else {
          this.log('最多只能选 ' + pd.need + ' 张。', 'warn');
        }
        this.render(pd.game);
        this.refreshActions();
      }
    }

    /**
     * ★ 多目标选择（借刀杀人的两次点选 / 铁索连环 / 方天画戟）：
     *   已在 pd.picked 里的角色框打 .target-picked + 序号，未选的不打。
     *   视觉由 CSS 负责：静态常亮高亮，覆盖 .targetable 的 target-pulse
     *   脉冲动画；借刀选完第一人后合法目标会切换，第一人即使不再
     *   targetable 也仍保留这个静态标记。
     *   每次 render 都整体重算，因此减选 / 取消会即时清掉。
     */
    markPickedTargets(pd, ai, me) {
      const picked = (pd && (pd.mode === 'targets' || pd.mode === 'chainTargets') &&
        Array.isArray(pd.picked)) ? pd.picked : [];
      [['ai-area', ai], ['me-area', me]].forEach(([id, p]) => {
        const el = $(id);
        if (!el) return;
        const i = picked.indexOf(p);
        if (el.classList) {
          el.classList.toggle('target-picked', i >= 0);
          el.classList.remove('chain-picked');   // 兼容旧类名
        }
        if (el.dataset) {
          if (i >= 0) el.dataset.targetOrder = String(i + 1);
          else delete el.dataset.targetOrder;
        }
        // dataset 与 attribute 在部分极简 DOM 环境不互通，双向兜底
        if (el.setAttribute) {
          if (i >= 0) el.setAttribute('data-target-order', String(i + 1));
          else if (el.removeAttribute) el.removeAttribute('data-target-order');
        }
      });
    }

    /** 清掉全部目标选择标记（finish / 取消 / 假界面重绘都走这里） */
    clearTargetPickMarks() {
      ['ai-area', 'me-area'].forEach((id) => {
        const el = $(id);
        if (!el) return;
        if (el.classList) {
          // 逐个移除，不依赖 DOMTokenList 的多参数支持（自测假 DOM 也安全）
          ['targetable', 'target-picked', 'chain-picked']
            .forEach((c) => el.classList.remove(c));
        }
        if (el.dataset) delete el.dataset.targetOrder;
        if (el.removeAttribute) el.removeAttribute('data-target-order');
      });
    }

    /** 结束当前等待并 resolve */
    finish(value) {
      const pd = this.pending;
      if (!pd) return;
      this.pending = null;
      this.setHint('');
      // 清理目标选择高亮 / 已选标记 / 目标牌区面板，避免状态残留
      this.clearTargetPickMarks();
      if (pd.mode === 'trick') this.closeTargetPanel();
      if (pd.mode === 'peek') this.closePeekPanel();
      // ★ 五谷丰登面板从亮牌起一直保留到全部分配结束，不在单次选牌后关闭
      if (pd.mode === 'chainTargets') this.closeChainHint();
      this.refreshActions(); // 无 pending 时显示「等待中…」
      pd.resolve(value);
    }

    /* ---------------- 目标选择 / 黄色直线动画 ---------------- */

    /** 点击角色卡确定目标；只有合法目标会被接受 */
    onHeroClick(key) {
      const pd = this.pending;
      if (!pd || (pd.mode !== 'target' && pd.mode !== 'targets' &&
                  pd.mode !== 'chainTargets')) return;
      const g = pd.game;
      // 当前 1v1 只有两张卡；多人局时把 data-player 映射到 game.players 即可
      const p = key === 'ai' ? g.aiPlayer : (key === 'me' ? g.human : null);
      if (!p) return;

      // ★ 借刀杀人：一次点两名，点击顺序决定「借刀目标 →【杀】目标」
      if (pd.mode === 'targets') {
        const picked = Array.isArray(pd.picked) ? pd.picked : [];
        if (picked.length >= (pd.need || 2)) return;
        const allowed = picked.length === 0
          ? (pd.targets || [])
          : g.listTargets(picked[0], { type: 'sha' }, 'sha');
        if (allowed.indexOf(p) < 0) {
          this.log('这不是【' + pd.card.name + '】当前可选的合法目标。', 'warn');
          return;
        }
        picked.push(p);
        pd.picked = picked;
        this.render(g);
        if (picked.length >= (pd.need || 2)) {
          this.finish(picked.slice());
        } else {
          this.setHint('已选借刀目标【' + p.name + '】，再点【杀】的目标（可点你自己的角色框）。');
        }
        return;
      }

      // ★ 铁索连环：一次点 1~2 名角色，点击顺序即目标顺序；可再点已选者取消
      if (pd.mode === 'chainTargets') {
        if ((pd.targets || []).indexOf(p) < 0) return;
        const picked = Array.isArray(pd.picked) ? pd.picked : [];
        const i = picked.indexOf(p);
        if (i >= 0) picked.splice(i, 1);
        else if (picked.length < (pd.max || 2)) picked.push(p);
        else { this.log('【' + pd.card.name + '】最多只能指定 ' + pd.max + ' 名角色。', 'warn'); return; }
        pd.picked = picked;
        this.render(g);
        this.refreshActions();
        this.setHint('【' + pd.card.name + '】已选 ' + picked.length + ' 名（' + picked.map((x) => x.name).join('、') +
          '），点操作区【确认】或继续点其他角色（最多 ' + pd.max + ' 名）。');
        return;
      }

      if (!p || (pd.targets || []).indexOf(p) < 0) {
        this.log('这不是【' + pd.card.name + '】的合法目标。', 'warn');
        return;
      }
      this.finish(p);
    }

    /** 响应：确认打出选中那张 need 牌（一进入响应即可直接选牌） */
    confirmRespond() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'respond' || !pd.selected) return;
      const card = pd.player.hand.find((c) => c.id === pd.selected);
      if (!card || !SGS.Cards.matchesRespond(card, pd.respondNeed || 'shan')) return;
      this.finish({ card: card, viaSkill: false });
    }

    /**
     * 目标连线：从选择方角色卡中心向目标方画一条黄色发光直线。
     * CSS 动画 1.5 秒：先自选择方生长到目标方，再自选择方开始渐消失。
     * 动画不阻塞结算，因此可与【顺手牵羊 / 过河拆桥】面板叠加显示。
     * ★ opts.lane：平行轨道偏移（像素）。1v1 借刀杀人会出现
     *   「我→对手」与「对手→我」两条线，几何完全重叠会看成只有一条；
     *   第二条线给 lane:1（沿垂线平移）后两条都能看清。
     */
    showTargetLine(fromPlayer, toPlayer, opts) {
      const app = $('app');
      if (!app || typeof document.createElement !== 'function') return false;
      const fromEl = $(fromPlayer.isHuman ? 'me-area' : 'ai-area');
      const toEl = $(toPlayer.isHuman ? 'me-area' : 'ai-area');
      if (!fromEl || !toEl || !fromEl.getBoundingClientRect || !toEl.getBoundingClientRect) {
        return false; // 无布局环境（Node 自测）安全跳过
      }
      const a = fromEl.getBoundingClientRect();
      const b = toEl.getBoundingClientRect();
      let x1 = a.left + a.width / 2, y1 = a.top + a.height / 2;
      let x2 = b.left + b.width / 2, y2 = b.top + b.height / 2;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (!len) return false;
      const lane = (opts && opts.lane) || 0;
      if (lane) {
        // 沿连线法线方向平移，保持两条黄线平行且方向仍然清晰
        const ox = (-dy / len) * lane * 16;
        const oy = (dx / len) * lane * 16;
        x1 += ox; y1 += oy; x2 += ox; y2 += oy;
      }

      const line = document.createElement('div');
      line.className = 'target-line';
      line.style.left = x1 + 'px';
      line.style.top = y1 + 'px';
      line.style.width = len + 'px';
      line.style.transform = 'rotate(' + (Math.atan2(dy, dx) * 180 / Math.PI) + 'deg)';
      app.appendChild(line);
      SGS.sleep(1500).then(() => {
        try {
          if (line.parentNode && line.parentNode.removeChild) line.parentNode.removeChild(line);
          else app.removeChild(line);
        } catch (e) { /* 元素已被移除，忽略 */ }
      });
      return true;
    }

    /**
     * ★ 一对多黄线：群体锦囊（万箭齐发 / 南蛮入侵 / 桃园结义）从使用者
     * 向每一名其他目标各画一条黄线。1v1 只有一条；多人局会同时散开成扇形。
     * 逐条复用 showTargetLine，因此自测假界面也能按次数统计。
     */
    showTargetLines(fromPlayer, targets) {
      (targets || []).forEach((t) => {
        if (t && t !== fromPlayer) this.showTargetLine(fromPlayer, t);
      });
    }

    /**
     * ★ 受击数值飘字 + 属性特效。
     *
     * 在受击角色框的 .hit-fx-host 里插入一组独立 .hit-fx（不复用技能大字
     * 宿主，避免两个动画互相清空）：
     *   · 普通伤害：只有 -N 飘字
     *   · 雷电伤害：飘字 + 蓝紫闪光 + 三道 SVG 电弧（闪烁抖动）
     *   · 火焰伤害：飘字 + 橙红闪光 + 六股错峰升腾的火苗
     * 整组动画结束自动移除；最多同时保留 4 组，连击时清掉最旧的。
     * 全部 pointer-events:none，不挡点角色框选目标。
     *
     * @param amount   最终实际伤害点数（Game.damage 已算好藤甲/白银狮子）
     * @param dmgType  'normal' | 'fire' | 'thunder'
     */
    showHitFX(player, amount, dmgType) {
      if (!player || typeof document === 'undefined') return false;
      const n = Number(amount);
      if (!(n > 0) || typeof document.createElement !== 'function') return false;
      const isMe = !!player.isHuman;
      const host = $(isMe ? 'me-hit-fx' : 'ai-hit-fx') ||
                   $(isMe ? 'me-area' : 'ai-area');
      if (!host || typeof host.appendChild !== 'function') return false;

      const kind = dmgType === 'thunder' ? 'fx-thunder'
        : (dmgType === 'fire' ? 'fx-fire' : 'fx-normal');
      const wrap = document.createElement('div');
      wrap.className = 'hit-fx ' + kind;
      wrap.setAttribute && wrap.setAttribute('data-dmg', String(n));

      let html = '<div class="dmg-float">-' + n + '</div>';
      if (kind === 'fx-thunder') {
        html += '<div class="fx-flash"></div>' +
          '<svg class="fx-arcs" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true">' +
          '<path class="fx-arc" d="M58 -5 L40 42 L60 50 L32 92 L54 100 L42 145"></path>' +
          '<path class="fx-arc a2" d="M20 2 L34 36 L18 46 L38 88 L22 100 L34 138"></path>' +
          '<path class="fx-arc a3" d="M84 6 L68 40 L86 50 L64 92 L82 104 L70 140"></path>' +
          '</svg>';
      } else if (kind === 'fx-fire') {
        html += '<div class="fx-flash"></div><div class="fx-flames">' +
          '<i class="fx-flame"></i>'.repeat(6) + '</div>';
      }
      wrap.innerHTML = html;

      // 连击时限制堆叠数量
      try {
        while (host.children && host.children.length > 3 && host.removeChild) {
          host.removeChild(host.children[0]);
        }
      } catch (e) { /* 极简 DOM 忽略 */ }
      host.appendChild(wrap);

      // 最长动画 1.15s，兜底 1.7s（与技能横幅同款，略长于淡出）
      const kill = () => {
        try {
          if (wrap.parentNode && wrap.parentNode.removeChild) {
            wrap.parentNode.removeChild(wrap);
          }
        } catch (e) { /* 已移除 */ }
      };
      if (wrap.addEventListener) wrap.addEventListener('animationend', kill);
      if (SGS.sleep) {
        try { SGS.sleep(1700).then(kill); } catch (e) { /* 无计时环境 */ }
      }
      return true;
    }

    /**
     * ★ 受击动画：给角色框加 .hit 类，CSS 做一次左右抖动 + 红闪；
     * 动画结束后移除类名，保证连续受击时能重播（先 remove 再强制重排）。
     * 传入 amount / dmgType 时，同时叠加伤害数值飘字与属性特效
     * （Game.damage 会传最终实际点数；旧调用只传 player，行为完全不变）。
     */
    shakeHero(player, amount, dmgType) {
      if (amount != null && typeof this.showHitFX === 'function') {
        this.showHitFX(player, amount, dmgType);
      }
      const el = $(player && player.isHuman ? 'me-area' : 'ai-area');
      if (!el || !el.classList) return false;
      el.classList.remove('hit');
      // 读一次布局属性强制浏览器应用「无 hit」状态，再重新加上以重播动画
      try { void (el.offsetWidth || el.getBoundingClientRect); } catch (e) { /* 无布局环境 */ }
      el.classList.add('hit');
      SGS.sleep(480).then(() => { el.classList.remove('hit'); });
      return true;
    }

    /* ---------------- 目标牌区面板（顺手牵羊 / 过河拆桥） ---------------- */

    /**
     * 目标牌区面板里的一张「明牌」（装备区 / 判定区）。
     * ★ 直接使用与展示区相同的原卡牌贴图：cardHTML() 会按 CARD_DEFS[].image
     *   渲染 assets/cards/*.webp（探测失败 / DOM error 自动回退 CSS 卡面），
     *   贴图本身带有名称与描述，所以这里只额外补花色 + 点数角标即可。
     * ★ 判定区：贴图逆时针旋转 90° 横置；花色点数单独叠在
     *   **右上角**、保持水平可读，不跟着卡面躺倒（内部原角标隐藏）。
     * 仅用于顺手牵羊 / 过河拆桥的面板，主战斗界面的装备栏不受影响。
     */
    tpFaceUpHTML(entry, rotated, opts) {
      const c = entry.card;
      // opts.noId：只读展示（寒冰剑的判定区）时连内部 .card 也不带 data-id
      const card = this.cardHTML(c, opts);
      if (!rotated) return card;
      // 旋转由 CSS 直接加在内部 .card 上（相对 .tp-card 绝对定位）；
      // .tp-corner 是 .tp-card 的直接子元素，不跟着旋转。
      return card +
        '<span class="tp-corner">' + (c.rank || '') + (c.suit || '') + '</span>';
    }

    /**
     * 渲染面板：标题 + 手牌牌背 + 装备区明牌 + 判定区明牌。
     * 「有牌」按任意区域算（zones.js）：手牌是暗信息 → 牌背；装备区与
     * 判定区的牌所有角色都能看到 → 直接用原卡牌贴图（不用牌背）。
     * 三个区域的牌都是**可选中**的，共用 sel / picked 上浮动画。
     */
    renderTargetPanel() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'trick') return;
      const panel = $('target-panel');
      // ★ 手牌牌背引用 assets/cards/back.webp；探测成功才插 <img> 并加 has-art，
      //   失败（含 DOM 级 error）移除 has-art，CSS 金色牌背 + ✦ 纹章立即恢复。
      const backUrl = this.art.back;
      let all = pd.handOnly
        ? SGS.Zones.list(pd.target).filter((e) => e.zone === 'hand')
        : SGS.Zones.list(pd.target);
      if (pd.onlySuit) all = all.filter((e) => e.card.suit === pd.onlySuit);
      // ★【麒麟弓】：面板只留装备区里的坐骑牌（+1 马 / -1 马）
      if (pd.horseOnly) {
        all = all.filter((e) => e.zone === 'equip' &&
          (e.zoneKey === 'horsePlus' || e.zoneKey === 'horseMinus'));
      }
      // ★ 寒冰剑一次选多张：判定区的牌不可选，但仍显示出来（只读）。
      //   过河拆桥 / 顺手牵羊则三个区域都能选。
      const excludeDelayed = !!pd.excludeDelayed;
      const selectedIds = Array.isArray(pd.selected)
        ? pd.selected : (pd.selected ? [pd.selected] : []);
      const selCls = (id) =>
        (selectedIds.indexOf(id) >= 0 ? ' sel' : '') +
        (pd.justPicked === id ? ' picked' : '');

      // ① 手牌区：暗牌，只显示牌背；没有手牌就整行不显示
      const handCards = all.filter((e) => e.zone === 'hand');
      const handRow = handCards.length
        ? '<div class="tp-row">' +
            '<div class="tp-label">手牌</div>' +
            '<div class="tp-cards">' + handCards.map((e) =>
              '<div class="tp-card' + selCls(e.id) + (backUrl ? ' has-art' : '') +
              '" data-id="' + e.id + '" title="手牌（暗）">' +
              (backUrl ? '<img class="tp-art" src="' + backUrl + '" alt="">' : '') +
              '<span class="tp-emblem">✦</span></div>'
            ).join('') + '</div></div>'
        : '';

      // ② 明牌小卡：装备区 / 判定区所有角色可见，直接用原卡牌贴图 + 花色点数。
      //   与桃园结义一样只铺实际存在的牌，不预留任何空槽位。
      const faceUp = (e, rotated) =>
        '<div class="tp-card face-up ' + (rotated ? 'delayed ' : '') +
        (e.card.color === 'red' ? 'red' : 'black') +
        selCls(e.id) + '" data-id="' + e.id + '" title="' + e.label + '">' +
        this.tpFaceUpHTML(e, rotated) +
        '</div>';
      const delayedFaceUp = (entry) => excludeDelayed
        ? '<div class="tp-card face-up delayed no-pick ' +
          (entry.card.color === 'red' ? 'red' : 'black') + '" title="判定区（不可弃）">' +
          this.tpFaceUpHTML(entry, true, { noId: true }) + '</div>'
        : faceUp(entry, true);

      let equipRow = '', delayedRow = '';
      if (!pd.handOnly) {
        const equips = all.filter((e) => e.zone === 'equip');
        const delayed = all.filter((e) => e.zone === 'delayed');
        if (equips.length) {
          equipRow = '<div class="tp-row">' +
            '<div class="tp-label">装备牌</div>' +
            '<div class="tp-slots">' + equips.map((e) => faceUp(e, false)).join('') +
            '</div></div>';
        }
        if (delayed.length) {
          delayedRow = '<div class="tp-row">' +
            '<div class="tp-label">判定区</div>' +
            '<div class="tp-slots">' + delayed.map(delayedFaceUp).join('') +
            '</div></div>';
        }
      }
      const anyCard = handCards.length || equipRow || delayedRow;

      const cnt = selectedIds.length;
      const defaultHint = pd.multi
        ? (cnt
          ? '已按点击顺序选 ' + cnt + '/' + pd.need + ' 张，可继续点选。'
          : '请依次点选 ' + pd.need + ' 张牌（点击顺序 = 弃牌顺序），再点【确认】。')
        : (pd.selected
          ? '已选择一张牌，点【确认】结算。'
          : (excludeDelayed
            ? '请点选目标的手牌或装备牌（判定区不可弃），再点【确认】。'
            : '请点选目标任意区域的一张牌，再点【确认】。'));
      const enough = pd.multi ? cnt >= pd.need : !!pd.selected;

      panel.innerHTML =
        '<div class="tp-title">' + pd.trickCard.name + '<span class="tp-arrow">▼</span></div>' +
        (anyCard ? handRow + equipRow + delayedRow
          : '<div class="tp-none">（目标没有任何牌）</div>') +
        '<div class="tp-foot">' +
          '<span id="tp-hint">' + (pd.auto
            ? '对方正在选择…'
            : ((pd.customHint && !cnt) ? pd.customHint : defaultHint)) +
          '</span>' +
          (pd.allowCancel && !pd.auto
            ? '<button id="tp-cancel" class="btn">不弃置</button>' : '') +
          '<button id="tp-confirm" class="btn primary"' +
            (enough && !pd.auto ? '' : ' disabled') + '>确认</button>' +
        '</div>';
      panel.classList.remove('hidden');
    }

    /** 点任意区域的一张牌：只选中（与其它选牌共用上浮动画），确认后才结算 */
    onTargetCardClick(id) {
      const pd = this.pending;
      if (!pd || pd.mode !== 'trick' || pd.auto) return;
      const entry = SGS.Zones.find(pd.target, id);
      if (!entry) return;
      // ★ 寒冰剑：判定区的牌不能被弃置
      if (pd.excludeDelayed && entry.zone === 'delayed') {
        this.log('判定区的牌不能被弃置。', 'warn');
        return;
      }
      // ★ 火攻：只能弃置与展示牌花色相同的手牌
      if (pd.onlySuit && (entry.zone !== 'hand' || entry.card.suit !== pd.onlySuit)) {
        this.log('只能弃置与火攻展示牌花色相同的手牌。', 'warn');
        return;
      }
      // ★【麒麟弓】：只能弃置目标装备区的坐骑牌
      if (pd.horseOnly && !(entry.zone === 'equip' &&
          (entry.zoneKey === 'horsePlus' || entry.zoneKey === 'horseMinus'))) {
        this.log('【麒麟弓】只能弃置坐骑牌。', 'warn');
        return;
      }
      if (pd.multi) {
        // ★ 寒冰剑一次选多张：数组顺序 = 点击顺序 = 弃牌顺序
        const arr = Array.isArray(pd.selected) ? pd.selected : [];
        const i = arr.indexOf(id);
        if (i >= 0) arr.splice(i, 1);
        else if (arr.length < pd.need) arr.push(id);
        else {
          this.log('最多只能选 ' + pd.need + ' 张。', 'warn');
          return;
        }
        pd.selected = arr;
      } else {
        pd.selected = pd.selected === id ? null : id;
      }
      pd.justPicked = id;
      this.renderTargetPanel();
    }

    /** 确认选牌 → 关闭面板并回传牌 id（多选时回传按点击顺序排列的数组） */
    confirmTrickCard() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'trick' || !pd.selected) return;
      if (pd.multi) {
        if (!Array.isArray(pd.selected) || pd.selected.length < pd.need) return;
      }
      this.closeTargetPanel();
      this.finish(Array.isArray(pd.selected) ? pd.selected.slice() : pd.selected);
    }

    /** 放弃本次选牌（火攻弃牌等可选步骤） */
    cancelTrickCard() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'trick' || pd.auto) return;
      this.closeTargetPanel();
      this.finish(null);
    }

    closeTargetPanel() {
      const panel = $('target-panel');
      if (!panel) return;
      panel.innerHTML = '';
      if (panel.classList) panel.classList.add('hidden');
    }

    /* ---------------- 交互 Promise（出牌 / 响应 / 弃牌 / 濒死 / 目标 / 目标牌区 / 可选技能） ---------------- */

    /**
     * 出牌阶段：
     *   {type:'use', card}                                  普通使用（牌面为杀 / 桃）
     *   {type:'use', card, viaSkill:true, conversion, scene:'play'}  技能按钮发动的转化
     *   {type:'end'}                                       结束出牌
     */
    waitPlay(player, game) {
      return new Promise((resolve) => {
        this.pending = { mode: 'play', player, game, resolve, selected: null };
        const zb = (SGS.Equipment && SGS.Equipment.hasZhangba(player) &&
                    player.hand.length >= 2 && player.canPlaySha())
          ? '；点左侧武器栏的【丈八蛇矛】可用两张手牌当【杀】' : '';
        this.setHint('出牌阶段：点选手牌 → 【使用】；「可以」类技能请点技能按钮发动' +
          zb + '；或结束出牌。');
        this.refreshActions();
        this.render(game);
      });
    }

    /**
     * 通用响应：不再询问「是否使用」，直接进入选牌状态。
     * opts.need   = 'shan'（杀 / 万箭齐发）| 'sha'（南蛮入侵 / 决斗）
     * opts.reason = 发起响应的牌名，仅用于引导文案。
     * 点一张 need 牌只选中（统一上浮动画），再点【使用【X】】确认；
     * 也可直接点技能按钮走龙胆转化，或点【不出【X】】。
     * 返回 null，或
     *   {card, viaSkill:false}          确认打出真正的 need 牌
     *   {card, viaSkill:true, conversion, scene:'respond'}  技能按钮转化的 need 牌
     */
    waitRespond(player, game, opts) {
      opts = opts || {};
      const need = opts.need || 'shan';
      const reason = opts.reason || '杀';
      return new Promise((resolve) => {
        this.pending = {
          mode: 'respond', player, game, resolve, selected: null,
          respondNeed: need, respondReason: reason
        };
        this.setHint(respondHint(player, need, reason, null));
        this.refreshActions();
        this.render(game);
      });
    }

    /** 弃牌阶段：返回要弃置的牌 id 数组 */
    waitDiscard(player, need, game) {
      return new Promise((resolve) => {
        this.pending = { mode: 'discard', player, game, resolve, selected: [], need };
        this.setHint('弃牌阶段：请点选 ' + need + ' 张手牌弃置，然后确认。');
        this.refreshActions();
        this.render(game);
      });
    }

    /**
     * ★ 通用「从自己手牌区点牌」：不弹目标牌区面板，直接用默认手牌选取动画。
     * 火攻的目标展示牌与使用者的同花色弃牌都走这里。
     * opts.filter     只让符合条件的牌可点（不符的置灰）
     * opts.need       要选几张（默认 1；>1 时回传按点击顺序排列的数组）
     * opts.confirmLabel / cancelLabel  操作区按钮文案（cancelLabel 为空则不显示）
     * opts.hint       顶部引导文案；opts.rejectHint 点了不可选的牌时的提示
     * opts.skillNeed / opts.skillScene  ★ 可选：在右下技能位显示转化按钮。
     *   只有传了 need 的选牌界面才有（当前仅【青龙偃月刀】追加杀用）；
     *   点进去走与其它响应一致的 openSkill / confirmSkill，回传的是
     *   {card, viaSkill, conversion, scene} 对象而不是牌 id，由调用方识别。
     *   pick 模式默认 pickFilter 仍只放行「天然可用」的牌，转化牌必须点
     *   技能按钮才能选 —— 与其它场景「主动技必须点按钮」的口径一致。
     */
    waitPick(player, game, opts) {
      opts = opts || {};
      const need = opts.need || 1;
      return new Promise((resolve) => {
        this.pending = {
          mode: 'pick', player, game, resolve,
          need, selected: [], pickFilter: opts.filter || null,
          allowEquip: !!opts.allowEquip,
          equipSelected: [],
          confirmLabel: opts.confirmLabel || '确认',
          cancelLabel: opts.cancelLabel || null,
          rejectHint: opts.rejectHint || null,
          card: opts.card || null,
          // ★ 追加杀的技能转化：openSkill 需要这两个字段来过滤转化方向
          skillNeed: opts.skillNeed || null,
          skillScene: opts.skillScene || 'respond',
          skillNoShaCount: !!opts.skillNoShaCount,
          respondNeed: opts.skillNeed || null,
          hintText: opts.hint || null
        };
        this.setHint(opts.hint || '请点选手牌，再点操作区的【' +
          (opts.confirmLabel || '确认') + '】。');
        this.refreshActions();
        this.render(game);
      });
    }

    /**
     * 濒死：saves 是手里所有可用的真【桃】/【酒】；技能描述写「牌」的
     * 转化（如【龙魂】♥ 当【桃】）由右下技能按钮独立进入，素材可以是
     * 手牌或装备区。返回其中一张（game.brink 会循环调用直到体力回到
     * 1 点以上），或 null 放弃。【酒】在此处次数不限。
     */
    waitBrink(player, saves, game) {
      const list = Array.isArray(saves) ? saves : (saves ? [saves] : []);
      return new Promise((resolve) => {
        // ★ selected 记录玩家点选的那一张【桃】/【酒】；确认前不自动使用。
        this.pending = { mode: 'brink', player, game, resolve, saves: list, selected: null };
        this.setHint('你已濒死！可点选手牌里的【桃】/【酒】；' +
          '也可点右下技能按钮，用手牌或装备区的「牌」转化当【桃】' +
          '（每张回复 1 点体力），再点上方操作区确认，或放弃。');
        this.refreshActions();
        this.render(game);
      });
    }

    /** 选择目标角色：返回被点选的 player，或 null（取消，牌不消耗） */
    waitTarget(user, card, targets, game) {
      return new Promise((resolve) => {
        this.pending = { mode: 'target', player: user, card, targets, game, resolve };
        this.setHint('【' + card.name + '】请选择目标：点击高亮的角色卡（1v1 也需选择），或取消。');
        this.refreshActions();
        this.render(game);
      });
    }

    /**
     * ★ 一次选择多名目标角色（借刀杀人）：先点「装备武器的目标」，
     * 再点其攻击范围内的「【杀】目标」（可以是使用者自己）。
     * 两次点击都在同一个交互里完成，按点击顺序返回 player 数组。
     */
    waitTargets(user, card, targets, game, need) {
      need = need || 2;
      return new Promise((resolve) => {
        this.pending = {
          mode: 'targets', player: user, card, targets, game, resolve,
          need: need, picked: []
        };
        this.setHint('【' + card.name + '】请依次点击 ' + need +
          ' 名角色：先选目标，再点【杀】的目标（可点你自己的角色框）。');
        this.refreshActions();
        this.render(game);
      });
    }

    /**
     * ★ 五谷丰登：一次亮出所有牌并打开面板，全程不关闭、每人依次选牌。
     * 被拿走的牌仍留在面板里，标注「已被 XX 拿走」且不可再选。
     */
    openWugu(game, cards) {
      this.wuguSession = {
        game: game, cards: (cards || []).slice(), taken: {}, turn: null
      };
      this.renderWuguPanel();
    }

    /**
     * ★ 五谷丰登：把「轮到 xx 选牌」写进面板内下方状态条。
     *   由规则层在【每个目标的无懈可击询问之前】调用一次并只重绘面板，
     *   不重建 session、不碰 pending、不改全局 #hint（那条会被面板挡住）。
     *   因此无懈询问弹出时，玩家仍能看清当前正在结算的是谁的目标。
     *   假界面没有这个方法时，规则层用 typeof 保护，静默降级。
     */
    setWuguTurn(name, index, total) {
      const s = this.wuguSession;
      if (!s) return;
      s.turn = { name: name || '', index: index || 0, total: total || 0 };
      this.renderWuguPanel();
    }

    /**
     * 轮到某人选牌：只更新当前选择者与提示，面板本身不重建。
     * 返回被点牌的 id（兼容性保留 cards/index/total 入参）。
     */
    waitWugu(game, player, card, cards, index, total) {
      if (!this.wuguSession || !this.wuguSession.cards.length) {
        this.openWugu(game, cards || []);
      }
      return new Promise((resolve) => {
        this.pending = {
          mode: 'wugu', player, card, game, resolve,
          index: index || 1, total: total || 1
        };
        this.setHint('【五谷丰登】轮到 ' + player.name + ' 从亮出的牌中点选一张获得。');
        this.refreshActions();
        this.render(game);
        this.renderWuguPanel();
      });
    }

    /** 五谷丰登面板：标题 + 当前选择者 + 一栏正面牌 + 底部「轮到 xx 选牌」状态条 */
    renderWuguPanel() {
      const s = this.wuguSession;
      if (!s) return;
      const pd = this.pending && this.pending.mode === 'wugu' ? this.pending : null;
      const panel = $('wugu-panel');
      if (!panel) return;
      const sub = pd
        ? '轮到 ' + pd.player.name + ' 选择（第 ' + pd.index + '/' + pd.total +
          ' 位）· 点击一张牌直接获得'
        : '五谷丰登 · 亮出的牌';
      // ★ 底部状态条：规则层在每次无懈询问之前 setWuguTurn，所以这里
      //   始终显示「当前正在结算的目标」，全局 #hint 被面板挡住也不影响。
      const turn = s.turn
        ? '<div class="wugu-turn" data-turn="' + escText(s.turn.name) + '">' +
            '<span class="wugu-turn-dot"></span>' +
            '轮到 <b>' + escText(s.turn.name) + '</b> 选牌' +
            (s.turn.total > 1
              ? '<span class="wugu-turn-idx">第 ' + s.turn.index + '/' +
                s.turn.total + ' 位</span>' : '') +
          '</div>'
        : '';
      panel.innerHTML =
        '<div class="wugu-title">五谷丰登</div>' +
        '<div class="wugu-sub">' + sub + '</div>' +
        '<div class="wugu-cards">' +
          s.cards.map((c) => {
            const owner = s.taken[c.id];
            return '<div class="wugu-card' + (owner ? ' taken' : '') + '"' +
              (owner ? '' : ' data-id="' + c.id + '"') + '>' +
              this.cardHTML(c) +
              (owner ? '<div class="wugu-taken">已被' + owner + '拿走</div>' : '') +
              '</div>';
          }).join('') +
        '</div>' +
        turn;
      panel.classList.remove('hidden');
    }

    /** 点五谷丰登面板里的牌：已拿走的牌不可再选 */
    onWuguCardClick(id) {
      const pd = this.pending;
      if (!pd || pd.mode !== 'wugu') return;
      const s = this.wuguSession;
      if (!s || !s.cards.some((c) => c.id === id)) return;
      if (s.taken[id]) {
        this.log('这张牌已被 ' + s.taken[id] + ' 拿走，请选其他牌。', 'warn');
        return;
      }
      this.finish(id);
    }

    /** 某张牌被某人拿走：只打标记并重绘，不移除卡片 */
    markWuguTaken(id, name) {
      const s = this.wuguSession;
      if (!s || !id) return;
      s.taken[id] = name || '他人';
      this.renderWuguPanel();
    }

    closeWuguPanel() {
      this.wuguSession = null;
      const panel = $('wugu-panel');
      if (!panel) return;
      panel.innerHTML = '';
      if (panel.classList) panel.classList.add('hidden');
    }

    /* ---------------- 【火计·火攻】查看目标手牌面板 ---------------- */

    /**
     * ★【卧龙诸葛·火计】改写的【火攻】：使用者查看目标的手牌，自己挑一张
     *   展示。面板里的牌是【正面】（使用者可以看见，不用牌背），点选只是
     *   「看 + 指定展示」，不会把牌拿走；确认后返回被选中的牌 id。
     * AI 不弹面板，由 tricks.resolveHuogong() 自动挑一张能造成伤害的。
     * 旧的「观看牌堆顶 / 控顶排序 / 代替弃置」设计已整体取消。
     */
    waitPeekHand(user, game, opts) {
      opts = opts || {};
      return new Promise((resolve) => {
        this.pending = {
          mode: 'peek', player: user, game, resolve,
          target: opts.target || null,
          cards: (opts.cards || []).slice(),
          selected: null, justPicked: null,
          confirmLabel: opts.confirmLabel || '展示',
          card: opts.card || null
        };
        this.setHint(opts.hint || '查看对方手牌，点选一张展示，再点【展示】。');
        this.refreshActions();
        this.render(game);
        this.renderPeekPanel();
      });
    }

    renderPeekPanel() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'peek') return;
      const panel = $('huogong-peek-panel');
      if (!panel) return;
      const who = (pd.target && pd.target.name) || '目标';
      const rows = pd.cards.map((c) =>
        '<div class="peek-card' +
        (pd.selected === c.id ? ' sel' : '') +
        (pd.justPicked === c.id ? ' picked' : '') +
        '" data-id="' + c.id + '">' +
        this.cardHTML(c) +
        (pd.selected === c.id ? '<div class="peek-badge">展示这张</div>' : '') +
        '</div>').join('');
      panel.innerHTML =
        '<div class="peek-title">火计 · 查看 ' + who + ' 的手牌</div>' +
        '<div class="peek-sub">点选一张让 ' + who + ' 展示，' +
          '再弃置一张与其颜色相同的手牌以造成伤害。</div>' +
        '<div class="peek-cards">' + rows + '</div>';
      if (panel.classList) panel.classList.remove('hidden');
    }

    onPeekCardClick(id) {
      const pd = this.pending;
      if (!pd || pd.mode !== 'peek') return;
      if (!pd.cards.some((c) => c.id === id)) return;
      pd.selected = pd.selected === id ? null : id;
      pd.justPicked = pd.selected;
      this.refreshActions();
      this.renderPeekPanel();
    }

    confirmPeek() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'peek' || !pd.selected) return;
      this.finish(pd.selected);
    }

    closePeekPanel() {
      const panel = $('huogong-peek-panel');
      if (!panel) return;
      panel.innerHTML = '';
      if (panel.classList) panel.classList.add('hidden');
    }

    /**
     * ★ 铁索连环目标选择：一次点 1~2 名角色（可含自己），点击顺序即目标顺序，
     *   再点已选者可取消；点操作区【确认】结束后返回 player 数组。
     */
    waitChainTargets(user, card, targets, game, min, max, hint) {
      min = min || 1;
      max = max || 2;
      return new Promise((resolve) => {
        this.pending = {
          mode: 'chainTargets', player: user, card, targets, game, resolve,
          min: min, max: max, picked: []
        };
        this.setHint(hint || ('【' + card.name + '】请点击 ' + min + '~' + max +
          ' 名角色（可以点你自己的角色框），再点【确认】。'));
        this.refreshActions();
        this.render(game);
      });
    }

    /** 铁索连环：确认当前点选的目标 */
    confirmChainTargets() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'chainTargets') return;
      if (!pd.picked || pd.picked.length < (pd.min || 1)) return;
      const picked = pd.picked.slice();
      this.finish(picked);
    }

    closeChainHint() {
      // 与 finish 共用一套清理：脉冲高亮、已选静态高亮、序号一并清掉
      this.clearTargetPickMarks();
    }

    /**
     * ★ 通用二选一（如【雌雄双股剑】让目标选「弃一张手牌 / 令对方摸一张牌」）。
     * opts.choices = [{label, value}]，返回被点选项的 value。
     */
    waitChoice(player, game, opts) {
      opts = opts || {};
      const choices = (opts.choices || []).slice();
      return new Promise((resolve) => {
        this.pending = {
          mode: 'choice', player, game, resolve, choices,
          name: opts.name || '', desc: opts.desc || ''
        };
        this.setHint(opts.desc || '请选择一项。');
        this.refreshActions();
        this.render(game);
      });
    }

    /**
     * 目标牌区选牌：弹出「顺手牵羊 / 过河拆桥 / 寒冰剑」面板。
     * （★【火攻】不再用此面板，改为 waitPick 走手牌区默认选牌动画。）
     * 默认可来自手牌区 / 装备区 / 判定区任意区域（zones.js）。
     * opts.excludeDelayed（寒冰剑）= true 时判定区只展示、不可选。
     * opts.need > 1（寒冰剑）= 一次点选多张，按点击顺序返回 id 数组；
     * opts.allowCancel = 给「不弃置」按钮。
     * opts.hint 可覆盖面板内引导文案。返回单张 id 或 id 数组。
     * 使用者是 AI 时面板同样展示，稍作停顿后自动选牌并确认。
     */
    waitTrickCard(game, user, target, trickCard, opts) {
      opts = opts || {};
      const excludeDelayed = !!opts.excludeDelayed;
      const need = Math.max(1, opts.need || 1);
      const multi = need > 1;
      return new Promise((resolve) => {
        this.pending = {
          mode: 'trick', player: user, target, trickCard, game, resolve,
          selected: multi ? [] : null, justPicked: null, auto: !SGS.isDecider(user),
          excludeDelayed: excludeDelayed, need: need, multi: multi,
          handOnly: !!opts.handOnly, onlySuit: opts.onlySuit || null,
          horseOnly: !!opts.horseOnly,
          allowCancel: !!opts.allowCancel,
          customHint: opts.hint || null
        };
        this.setHint(SGS.isDecider(user)
          ? (opts.hint || ('【' + trickCard.name + '】：在上方目标牌区（手牌 / 装备 / 判定区）选一张牌。'))
          : '对方正在使用【' + trickCard.name + '】…');
        this.refreshActions();
        this.render(game);
        this.renderTargetPanel();

        if (!SGS.isDecider(user)) {
          SGS.sleep(650).then(() => {
            const cur = this.pending;
            if (!cur || cur.mode !== 'trick' || !cur.auto) return;
            let all = cur.handOnly
              ? SGS.Zones.list(cur.target).filter((e) => e.zone === 'hand')
              : (excludeDelayed ? SGS.Zones.disposable(cur.target) : SGS.Zones.list(cur.target));
            if (cur.onlySuit) all = all.filter((e) => e.card.suit === cur.onlySuit);
            // ★【麒麟弓】：AI / 自动演示时也只能从装备区坐骑里挑，不能拿手牌凑数
            if (cur.horseOnly) {
              all = all.filter((e) => e.zone === 'equip' &&
                (e.zoneKey === 'horsePlus' || e.zoneKey === 'horseMinus'));
            }
            if (!all.length) { this.closeTargetPanel(); this.finish(multi ? [] : null); return; }
            const pool = all.slice();
            const picks = [];
            for (let i = 0; i < cur.need && pool.length; i++) {
              picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
            }
            cur.selected = multi ? picks.map((e) => e.id) : picks[0].id;
            cur.justPicked = cur.selected;
            this.renderTargetPanel();
            SGS.sleep(280).then(() => {
              const ok = multi
                ? (Array.isArray(cur.selected) && cur.selected.length >= cur.need)
                : !!cur.selected;
              if (this.pending === cur && ok) this.confirmTrickCard();
            });
          });
        }
      });
    }

    /**
     * 「可以」类装备技能询问（【八卦阵】判定闪 /【朱雀羽扇】普通杀改火杀）。
     * 与角色技能按钮（右下）不同，这里只问「发动 / 不发动」两个按钮，
     * 放在手牌上方操作区，避免抢占技能位。返回 boolean。
     *
     * opts：name 技能名、desc 引导文案、yes / no 可自定义按钮文案。
     * AI 侧不走这里，由 ai.askOptional() 直接决策。
     */
    waitOptional(player, game, opts) {
      opts = opts || {};
      return new Promise((resolve) => {
        this.pending = {
          mode: 'optional', player: player, game: game, resolve: resolve,
          optName: opts.name || '技能',
          yes: opts.yes || null,
          no: opts.no || null
        };
        this.setHint(opts.desc || '');
        this.refreshActions();
        this.render(game);
      });
    }

    /**
     * ★【无懈可击】响应询问：使用 / 不使用 / 本轮不使用。
     * 第三个按钮会把 optOut 传给规则层，整张锦囊（含 AOE 后续目标与
     * 无懈打无懈的嵌套链）都不再询问该玩家，省去逐个点击。
     */
    waitWuXie(player, game, opts) {
      opts = opts || {};
      const cardName = opts.card ? opts.card.name : '锦囊';
      const targetName = opts.target ? opts.target.name : '';
      const userName = opts.user ? opts.user.name : '';
      const last = opts.lastWuXie ? opts.lastWuXie.name : '';
      // 本轮若无人再出无懈，最初那张锦囊最终是生效还是失效。
      // 每张无懈翻转一次：奇数张 → 失效，偶数张（含 0 张）→ 生效。
      const finalWord = opts.negated ? '失效' : '生效';
      let hint;
      if (last) {
        // ★ 无懈打无懈：说清这张无懈是抵消「谁的无懈」，以及不抵消的后果。
        hint = '【无懈可击】：是否使用【无懈可击】抵消 ' + last +
          ' 的【无懈可击】效果？若不抵消，此时 ' +
          (userName ? userName + ' 的' : '') + '【' + cardName + '】' + finalWord + '。';
      } else {
        hint = '【无懈可击】：是否使用【无懈可击】抵消【' + cardName + '】' +
          (targetName ? '对 ' + targetName + ' ' : '') +
          '的效果？若不抵消，【' + cardName + '】将' + finalWord + '。';
      }
      return new Promise((resolve) => {
        this.pending = {
          mode: 'wuxie', player: player, game: game, resolve: resolve,
          card: opts.card || null, target: opts.target || null,
          source: opts.source || null, user: opts.user || null,
          lastWuXie: opts.lastWuXie || null,
          hintText: hint,
          allowOptOut: !!opts.multiTarget
        };
        this.setHint(hint);
        this.refreshActions();
        this.render(game);
      });
    }

    /** 从「使用【无懈可击】」按钮进入默认手牌选牌动画 */
    pickWuXieCard() {
      const pd = this.pending;
      if (!pd || pd.mode !== 'wuxie') return;
      this.waitPick(pd.player, pd.game, {
        need: 1,
        filter: (c) => c.type === 'wuxiekeji',
        confirmLabel: '无懈可击', cancelLabel: '返回',
        hint: '【无懈可击】：请从手牌区点选一张【无懈可击】。',
        rejectHint: '只有【无懈可击】能用于这次响应。'
      }).then((id) => {
        // ★ waitPick 的确认/取消已经把自己的 pending 清掉了；这里要结束的是
        //   外层无懈询问。必须先把它恢复成当前 pending，否则 finish() 会
        //   因 this.pending 为 null 直接返回，外层 Promise 永远挂起。
        if (id) {
          this.pending = pd;
          this.finish(id);
        } else {
          // 取消选牌 → 回到询问按钮，不消耗这次响应机会
          this.pending = pd;
          // ★ 恢复外层无懈链提示（waitPick 期间被「请从手牌区点选」覆盖过）
          if (pd.hintText) this.setHint(pd.hintText);
          this.refreshActions();
          this.render(pd.game);
        }
      });
    }

    /* ---------------- 结算 ---------------- */

    showGameOver(win) {
      // 结算画面出现后 BGM 停止（再来一局走 reload，会重新启动）
      try { if (SGS.Audio && SGS.Audio.pauseBgm) SGS.Audio.pauseBgm(); }
      catch (e) { /* 静默 */ }
      $('result-text').textContent = win ? '🎉 你赢了！' : '💀 你输了';
      $('result-sub').textContent = win
        ? (this.vsAI === false ? '对手体力归零，对局结束。' : 'AI 体力归零，对局结束。')
        : '你的体力归零，再来一局吧。';
      $('result-screen').classList.remove('hidden');
    }
  }

  UI.prototype.SHOWCASE_LIMIT = 5;   // 常规展示上限；阵亡弃置条目豁免

  SGS.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
