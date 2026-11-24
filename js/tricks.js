/**
 * tricks.js
 * 锦囊牌的效果结算 + 使用合法性判定（含「距离」判定系统 + 「目标选择」系统）。
 *
 * 本文件只负责「锦囊怎么生效」；牌面 / 目标规则在 cards.js，主循环在 game.js，
 * 距离的基础公式在 core.js 的 SGS.seatDistance()。
 *
 * ── 距离判定（与原版三国杀一致）──────────────────────────────
 * 角色按 game.players 的数组顺序逆时针落座。两名角色的距离 =
 * 沿座位圈两个方向中较短一侧所隔的座位数：min(|i-j|, n-|i-j|)。
 * 相邻为 1，自己与自己是 0。Game.distance() 在此基础上叠加坐骑修正，
 * 因此将来接入 +1 马 / -1 马时，这里的锦囊校验无需任何改动。
 * 当前 1v1 只有 2 人，双方距离恒为 1，【顺手牵羊】总是满足距离条件。
 *
 * ── 十一种锦囊 ──────────────────────────────────────────────
 *  无中生有  对自己使用（不弹目标选择），摸两张牌
 *  五谷丰登  对全体亮出等同人数的牌，从使用者起逆时针各选一张（独立选牌面板）
 *  过河拆桥  选一名「其他 + 任意区域有牌」角色（无距离限制），弃置其一张牌
 *  顺手牵羊  选一名「其他 + 任意区域有牌 + 距离为 1」角色，获得其一张牌
 *  万箭齐发  对所有其他角色：各需打出一张【闪】，否则各受 1 点伤害
 *  南蛮入侵  对所有其他角色：各需打出一张【杀】，否则各受 1 点伤害
 *             （【藤甲】装备者对这两个群体锦囊完全无效；need='sha' 时
 *              【火杀】【雷杀】也能直接打出响应）
 *  桃园结义  对每名角色（含自己）：各回复 1 点体力
 *  决斗      选一名其他角色：由目标起轮流打【杀】，先不出者受对方 1 点伤害
 *  火攻      展示手牌，弃同花色手牌则造成 1 点火焰伤害（可选自己）
 *            ★【卧龙诸葛·火计】改写：使用者查看目标手牌并挑一张展示，
 *              弃置「颜色相同」的手牌；取消旧的观看牌堆顶 / 控顶排序设计
 *  借刀杀人  令目标对另一名角色出【杀】，否则其武器归你
 *  铁索连环  横置 / 重置 1~2 名角色；横置者在属性伤害下依次传导并全部重置；
 *            也可重铸（弃置摸一张，不视为使用）
 *
 * ── 目标选择 ──────────────────────────────────────────────
 * 全部锦囊统一走 Game.selectTargets()：
 *   mode 'other'       玩家必须点高亮的角色卡确认，即使 1v1 也不自动指定；
 *                      取消则牌留在手里、不消耗。画一条黄线。
 *   mode 'all'         全场每名角色（含自己）
 *   mode 'all-others'  所有其他角色
 *   后两者是自动生效的群体牌，**不弹选择**，但从使用者向每个其他目标
 *   各拉一条黄线（★ 一对多），多目标时散开成扇形。
 *   mode 'self'        只对自己，不画线。
 * 过河拆桥 / 顺手牵羊随后弹出「目标牌区」面板（ui.waitTrickCard），
 * 由使用者从目标**任意区域**里挑一张结算：手牌区 / 装备区四槽 / 判定区。
 * 手牌是暗信息，面板显示牌背（back.webp，失败回退 CSS 牌背）；
 * 装备区与判定区是明牌，面板直接铺原卡牌贴图（自带名称与描述，只补花色
 * 点数），不用牌背；判定区贴图顺时针旋转 90°、花色点数放右上角。
 * 「有牌角色」与「可选牌列表」统一由 zones.js 提供，三个区域一视同仁。
 *
 * ── 卡牌移动动画 ──────────────────────────────────────────
 * 所有出场牌统一走 Game.presentCard() → ui.flyCard()：使用者自己的牌从
 * 手牌区飞入展示区，其他角色打出的牌从其角色框飞入展示区。
 * 过河拆桥被弃置的牌：从目标角色框飞入展示区（正面公开，牌进弃牌堆）。
 * 顺手牵羊被获得的牌（玩家）：与摸牌共用 ui.flipInsertIntoHand() —— 旧手牌
 * FLIP 平滑让位，新牌【正面朝上】从目标角色框飞进自己最终的格子，落地即
 * 恢复真牌；不再背面朝上、也不再落地瞬间跳位。AI 获得牌仍按来源明暗区分。
 * 摸牌阶段与无中生有的摸牌统一走 Game.drawCards()：玩家同样是「正面插入
 * 手牌区」；AI 手牌不可见，沿用背面朝上叠放飞向角色框。
 * 两种来源共用 ui.flipInsertIntoHand() / ui.handAppendX()。
 * 展示区最多保留 5 张（阵亡弃置条目豁免），角色回合结束由 Game.runTurn 清空。
 *
 * 本作不实现【无懈可击】，锦囊本身不会被无懈响应；但群体锦囊 / 决斗
 * 会按规则通过 Game.askRespond() 向目标索要【闪】或【杀】再结算。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  const log = (msg, cls) => { if (SGS.log) SGS.log(msg, cls); };

  /** 十一种锦囊（同时作为 isTrick 的判定来源），目标细节统一读 cards.js */
  const SPECS = {
    wuzhong:  true,
    guohe:    true,
    shunshou: true,
    wanjian:  true,
    nanman:   true,
    taoyuan:  true,
    juedou:   true,
    huogong:  true,
    jiedaosharen: true,
    wugufengdeng: true,
    tiesuolianhuan: true,
    lebusishu: true, bingliangcunduan: true, shandian: true,
    wuxiekeji: true
  };

  /** 这张锦囊是否需要显式选择目标角色 */
  function needsTarget(card) {
    return SGS.Cards.needsTarget(card.type);
  }

  /**
   * 列出这张锦囊当前所有合法目标（已按 game.players 的逆时针顺序）。
   * 直接委托 Game.listTargets()，保证杀与锦囊共用同一套距离 / 有牌校验。
   * 无目标型锦囊（无中生有）返回 [使用者自己]。
   */
  function targetsFor(game, user, card) {
    if (!SPECS[card.type]) return [];
    if (game && typeof game.listTargets === 'function') {
      return game.listTargets(user, card);
    }
    // 兜底：没有 Game 实例时（纯数据测试）按牌面规则自行筛选
    const t = SGS.Cards.targetOf(card.type);
    const alive = (game.players || [user]).filter((p) => !p.isDead());
    if (t.mode === 'all') return alive;
    if (t.mode === 'all-others') return alive.filter((p) => p !== user);
    if (t.mode === 'any') {
      return alive.filter((p) => !t.needHand || (p.hand && p.hand.length > 0));
    }
    if (t.mode === 'borrow') {
      return alive.filter((p) => p !== user && p.equips && p.equips.weapon);
    }
    if (t.mode !== 'other') return [user];
    return alive.filter((p) =>
      p !== user && (!t.needCards || SGS.Zones.hasAny(p))
    );
  }

  /** 这张锦囊此刻能否使用；不能用时给出可直接展示给玩家的原因 */
  function canUse(game, user, card) {
    if (!SPECS[card.type]) return { ok: false, reason: '未知的锦囊牌。' };
    // ★【无懈可击】是响应专用锦囊：只能在锦囊生效前打出，不能主动使用
    if (SGS.Cards.defs[card.type] && SGS.Cards.defs[card.type].responseOnly) {
      return { ok: false, reason: '【无懈可击】只能在锦囊生效前作为响应打出。' };
    }
    const mode = SGS.Cards.targetOf(card.type).mode;
    const targets = targetsFor(game, user, card);
    if (mode === 'self') {
      if (!targets.length) {
        return { ok: false, reason: '自己判定区已有【' + card.name + '】，不能重复使用。' };
      }
      return { ok: true, targets: targets };
    }

    if (!targets.length) {
      let reason = '这张锦囊当前没有合法目标。';
      if (card.type === 'shunshou') reason = '没有距离为 1 且有牌的其他角色，不能使用【顺手牵羊】。';
      else if (card.type === 'guohe') reason = '没有其他有牌的角色，不能使用【过河拆桥】。';
      else if (card.type === 'juedou') reason = '没有其他角色可以决斗。';
      else if (card.type === 'huogong') reason = '没有有手牌的角色，不能使用【火攻】。';
      else if (card.type === 'jiedaosharen') reason = '没有其他装备武器的角色，不能使用【借刀杀人】。';
      else if (card.type === 'lebusishu') reason = '没有其他角色，不能使用【乐不思蜀】。';
      else if (card.type === 'bingliangcunduan') reason = '没有距离为 1 的其他角色，不能使用【兵粮寸断】。';
      return { ok: false, reason: reason };
    }
    // ★ 桃园结义不再判断全场体力：即使所有人都满血也可以使用，
    //   resolveTaoyuan() 里逐人 Math.min(maxHp, hp+1)，不会超过体力上限。
    return { ok: true, targets: targets };
  }

  /**
   * 从目标**任意区域**选一张牌：委托 ui.waitTrickCard() 弹出「顺手牵羊 /
   * 过河拆桥」面板。面板列出手牌区（牌背）、装备区四槽、判定区（后两者正面），
   * 玩家点一张并确认，AI 则由面板自动选一张。返回 {card, zone, zoneKey,
   * label, faceUp, note} —— 携带来源区域，供后续动画与日志使用。
   * 取牌动作本身由 SGS.Zones.take() 完成，它会从对应区域真正移除这张牌。
   */
  async function pickTargetCard(game, user, target, card) {
    let id = null;
    if (game.ui && typeof game.ui.waitTrickCard === 'function') {
      id = await game.ui.waitTrickCard(game, user, target, card);
    }
    if (id) {
      const entry = SGS.Zones.take(target, id);
      if (entry) return entry;
    }
    // 界面未返回有效 id 时随机兜底（优先暗手牌，其次明牌）
    return SGS.Zones.takeRandom(target);
  }

  /**
   * 群体锦囊（万箭齐发 / 南蛮入侵）：逐个目标索要 need 类型的响应牌，
   * 打不出则各受 1 点伤害。响应牌同样从手牌区 / 角色框飞入展示区。
   * 龙胆等转化技能由 Game.askRespond() 按 need 自动处理；need='sha' 时
   * 【火杀】【雷杀】也能直接打出响应。
   * ★【藤甲】装备者对这些群体锦囊完全无效：跳过响应与伤害。
   */
  async function resolveAOE(game, user, targets, need, reason, wxCtx) {
    const needName = SGS.Cards.nameOf(need);
    for (const t of targets) {
      if (t.isDead() || game.isEffectNegated(wxCtx, t)) continue;
      // ★ 群体锦囊按使用者起逆时针逐个询问无懈；被无懈的角色完全跳过
      if (wxCtx && await game.askWuXie(wxCtx, t, user)) continue;
      // ★【藤甲】锁定技：【南蛮入侵】/【万箭齐发】对该角色无效，
      //   既不需要打出【杀】/【闪】，也不会受到伤害。
      if (SGS.Equipment && SGS.Equipment.blocksAOE(t, reason)) {
        log('【藤甲】使 ' + t.name + ' 不受【' + reason + '】影响。', 'shan');
        game.ui.render(game);
        await SGS.sleep(200);
        continue;
      }
      const res = await game.askRespond(t, need, reason);
      if (res) {
        const c = res.card;
        // ★【八卦阵】判定成功是「虚拟响应」：没有实体牌，不移除手牌、
        //   不弃置，判定牌已由 Judge.run() 进弃牌堆。
        if (!res.virtual && c) {
          await game.presentCard(c, t, { dest: 'showcase', asName: res.viaSkill ? needName : null });
          await game.discardConsumed(t, c);
        }
        const txt = res.virtual
          ? (res.virtualText || ('发动【' + (res.sourceName || '技能') +
              '】视为打出【' + needName + '】'))
          : res.viaSkill
            ? '发动【' + (SGS.skillNameFor(t, 'respond') || t.skill.name) +
              '】将【' + c.name + '】当【' + needName + '】打出'
            : '打出【' + needName + '】';
        log(t.name + ' ' + txt + '，抵消了【' + reason + '】。', 'shan');
        game.ui.render(game);
        await SGS.sleep(200);
      } else {
        log(t.name + ' 没有打出【' + needName + '】。', 'warn');
        await game.damage(t, user, 1);
        if (game.over) return;
      }
    }
  }

  /** 桃园结义：对每名目标（含使用者）各回复 1 点体力 */
  /**
   * 桃园结义：对每名角色各回复 1 点体力（不超过上限）。
   * ★ 使用前不再判断全场是否满血：满血的人只记一句「无需回复」，
   *   体力上限用 Math.min 钳制，绝不会溢出。
   */
  async function resolveTaoyuan(game, targets, user, wxCtx) {
    for (const t of targets) {
      if (t.isDead() || game.isEffectNegated(wxCtx, t)) continue;
      if (wxCtx && await game.askWuXie(wxCtx, t, user)) continue;
      if (t.hp >= t.maxHp) {
        log(t.name + ' 体力已满，无需回复。', 'sys');
        continue;
      }
      // ★ 统一加血入口：真正回复才播 07 号加血音效（满血已在上面 continue）
      if (typeof game.healPlayer === 'function') {
        game.healPlayer(t, 1);
      } else {
        t.hp = Math.min(t.maxHp, t.hp + 1);
        try { if (SGS.Audio && SGS.Audio.playHeal) SGS.Audio.playHeal(); } catch (e) {}
      }
      log(t.name + ' 回复 1 点体力，至 ' + t.hp + '/' + t.maxHp + '。', 'heal');
      game.ui.render(game);
      await SGS.sleep(180);
    }
  }

  /**
   * 决斗：由目标开始，双方轮流打出一张【杀】；首先不出【杀】的一方
   * 受到「另一方造成的」1 点伤害。打出的【杀】只进弃牌堆，不计出杀次数、
   * 不消耗【酒】加成（那是「使用」而非「打出」）。
   */
  async function resolveDuel(game, user, target, wxCtx) {
    if (game.isEffectNegated(wxCtx, target)) return;
    let cur = target, other = user;
    let guard = 0;
    while (guard++ < 40) {
      const res = await game.askRespond(cur, 'sha', '决斗');
      if (!res) {
        log(cur.name + ' 无法再打出【杀】，受到 ' + other.name + ' 造成的 1 点伤害。', 'warn');
        await game.damage(cur, other, 1);
        return;
      }
      const c = res.card;
      if (!res.virtual && c) {
        await game.presentCard(c, cur, { dest: 'showcase', asName: res.viaSkill ? '杀' : null });
        await game.discardConsumed(cur, c);
      }
      const txt = res.virtual
        ? (res.virtualText || ('发动【' + (res.sourceName || '技能') + '】视为打出【杀】'))
        : res.viaSkill
          ? '发动【' + (SGS.skillNameFor(cur, 'respond') || cur.skill.name) +
            '】将【' + c.name + '】当【杀】打出'
          : '打出【杀】';
      log(cur.name + ' ' + txt + ' 响应【决斗】。', 'sha');
      game.ui.render(game);
      await SGS.sleep(200);
      const tmp = cur; cur = other; other = tmp;
    }
  }

  /** 牌的颜色（红 ♥♦ / 黑 ♠♣）；无花色时按 color 字段兜底 */
  function cardColor(c) {
    if (!c) return null;
    if (c.color === 'red' || c.color === 'black') return c.color;
    if (c.suit === '\u2665' || c.suit === '\u2666') return 'red';
    if (c.suit === '\u2660' || c.suit === '\u2663') return 'black';
    return c.color || null;
  }

  /** AI 火计时挑一张「自己弃得起牌」的展示牌，确保能造成伤害 */
  function pickForPeek(user, hand, byColor) {
    const mine = (user && user.hand) || [];
    const ok = hand.filter((c) => byColor
      ? mine.some((m) => cardColor(m) === cardColor(c))
      : mine.some((m) => m.suit === c.suit));
    return ok[0] || null;
  }

  /**
   * 火攻：目标展示一张手牌（牌不消失，只亮到展示区），使用者弃置一张
   * 与展示牌相同的【手牌】以造成 1 点火焰伤害。★ 目标可以选自己。
   *
   * ★ 两种规则：
   *   ① 原版（普通角色）：由【目标】自己决定展示哪张；使用者弃置
   *      「花色相同」的手牌。
   *   ②【火计】改写（卧龙诸葛，skill.huogongRule）：
   *        peek  = true    使用者查看目标全部手牌，自己挑一张展示
   *                        （新 UI：ui.waitPeekHand()）
   *        match = 'color' 弃置「颜色相同」的手牌（红 ♥♦ / 黑 ♠♣）
   *      取消控顶：不再观看牌堆顶、不再排序、不再有「代替弃置」分支。
   *
   * ★ 弃置的牌明确写「手牌」，因此只从 user.hand 里选（不含装备区）；
   *   「牌」与「手牌」的区分由 SGS.Zones.conversionCards() 统一约定。
   */
  async function resolveHuogong(game, user, target, card, wxCtx) {
    if (game.isEffectNegated(wxCtx, target)) return;
    const rule = (user && user.skill && user.skill.huogongRule) || null;
    const peek = !!(rule && rule.peek);
    const byColor = !!(rule && rule.match === 'color');

    const hand = (target.hand || []).filter(Boolean);
    if (!hand.length) {
      log(target.name + ' 没有手牌，【火攻】无法展示。', 'warn');
      return;
    }

    let shown = null;
    if (peek) {
      // ★【火计】：使用者查看目标手牌，自己挑一张展示
      let id = null;
      if (SGS.isDecider(user) && game.ui && typeof game.ui.waitPeekHand === 'function') {
        id = await game.ui.waitPeekHand(user, game, {
          target: target, cards: hand, card: card,
          hint: '【火计·火攻】查看 ' + target.name + ' 的手牌，' +
            '点选一张展示，再点操作区的【展示】。',
          confirmLabel: '展示'
        });
      }
      if (id) shown = hand.find((c) => c.id === id) || null;
      if (!shown) {
        // AI（或玩家取消）：优先挑一张使用者手里有同色手牌可弃的
        shown = pickForPeek(user, hand, byColor) || hand[0];
      }
      log(user.name + ' 发动【' + (SGS.skillNameFor(user, 'play') || '火计') +
        '】，查看 ' + target.name +
        ' 的手牌并展示其中一张。', 'sys');
    } else {
      // 原版：目标自己决定展示哪张
      if (SGS.isDecider(target) && game.ui && typeof game.ui.waitPick === 'function') {
        const id = await game.ui.waitPick(target, game, {
          hint: '【火攻】请点选一张手牌展示（这张牌不会消失），再点【展示】。',
          confirmLabel: '展示', card: card
        });
        if (id) shown = hand.find((c) => c.id === id) || null;
      }
      if (!shown) shown = hand[Math.floor(Math.random() * hand.length)];
    }

    await game.presentCard(shown, target, {
      dest: 'showcase', note: '火攻展示',
      // ★ 这张牌只是「亮出来」，仍留在目标手里：keepInHand 让飞牌只做替身，
      //   不把真牌从手牌区摘掉（否则手牌区会空出一格等快照补回来）。
      keepInHand: true,
      from: target.isHuman ? undefined : 'hero'
    });
    log((peek ? user.name + ' 展示 ' + target.name : target.name) +
      ' 的手牌【' + shown.name + '】' + (shown.suit || '') + '。', 'trick');
    game.ui.render(game);
    await SGS.sleep(220);

    // 弃置条件：火计按「颜色相同」，原版按「花色相同」；都必须是【手牌】
    const same = (c) => byColor
      ? cardColor(c) === cardColor(shown)
      : c.suit === shown.suit;
    const matching = (user.hand || []).filter(same);
    if (!matching.length) {
      log(user.name + ' 没有与展示牌' + (byColor ? '颜色相同' : '花色相同') +
        '的手牌，火攻失败。', 'warn');
      return;
    }
    let discard = null;
    if (SGS.isDecider(user) && game.ui && typeof game.ui.waitPick === 'function') {
      const id = await game.ui.waitPick(user, game, {
        hint: '【火攻】：点选一张与展示牌【' + shown.suit +
          '】' + (byColor ? '颜色相同' : '花色相同') +
          '的手牌弃置，或点「不弃置」。',
        confirmLabel: '弃置', cancelLabel: '不弃置',
        filter: same,
        rejectHint: '只能弃置与火攻展示牌' +
          (byColor ? '颜色相同' : '花色相同') + '的手牌。',
        card: card
      });
      if (id) discard = user.hand.find((c) => c.id === id) || null;
    } else {
      discard = matching[0];
    }
    if (!discard || !same(discard)) {
      log(user.name + ' 未弃置' + (byColor ? '同颜色' : '同花色') +
        '手牌，火攻失败。', 'warn');
      return;
    }
    await game.presentCard(discard, user, { dest: 'showcase', note: '火攻弃置' });
    await game.discardConsumed(user, discard);
    log(user.name + ' 弃置' + (byColor ? '同颜色' : '同花色') +
      '手牌【' + discard.name + '】，对 ' + target.name +
      ' 造成 1 点火焰伤害。', 'fire');
    game.ui.render(game);
    await SGS.sleep(200);
    // ★【火攻】造成的伤害固定走 06 号作用音效（不按 1 点火焰伤害走 05）
    await game.damage(target, user, 1, 'fire', { sound: 'huogong' });
  }

  /**
   * 借刀杀人：目标是否使用【杀】由 Game.askRespond 统一询问（含 AI）。
   * ① 使用【杀】→ 再画一条「目标 →【杀】目标」的黄线，按正常【杀】结算；
   * ② 不使用 → 装备区的武器从目标处飞给使用者（顺手牵羊同款动画）。
   */
  async function resolveBorrow(game, user, target, other, card, wxCtx) {
    if (game.isEffectNegated(wxCtx, target)) return;
    const weapon = target.equips && target.equips.weapon;
    if (!weapon) {
      log(target.name + ' 装备区已无武器，【借刀杀人】无法继续。', 'warn');
      return;
    }
    const res = await game.askRespond(target, 'sha', '借刀杀人');
    if (res) {
      // ★ 目标真的使用【杀】：把黄线从目标角色再拉到另一名角色
      //   （与借刀使用阶段那条同轨，走 lane 1 便于和第一条区分）
      if (game.ui && typeof game.ui.showTargetLine === 'function') {
        game.ui.showTargetLine(target, other, { lane: 1 });
      }
      await SGS.sleep(300);
      let sha = res.card;
      if (!sha || res.virtual) {
        sha = {
          id: SGS.uid('vsha'), type: 'sha', name: '杀', category: 'basic',
          rank: '', suit: '', color: null, damageType: 'normal'
        };
      } else {
        await game.presentCard(sha, target, {
          dest: 'showcase', asName: res.viaSkill ? '杀' : null
        });
        await game.discardConsumed(target, sha);
      }
      log(target.name + ' 对 ' + other.name + ' 使用【杀】（【借刀杀人】）。', 'sha');
      await game.useSha(target, sha, false, other, { consumed: true });
    } else {
      log(target.name + ' 未使用【杀】，须将武器交给 ' + user.name + '。', 'sys');
      await game.presentCard(weapon, target, {
        from: target.isHuman ? 'equip' : 'hero',
        slot: 'weapon',
        dest: user.isHuman ? 'hand' : 'ai-hero',
        // ★ 获得者显式下发：联机层据此按座位号判「谁能看正面」
        //   （provide=target / receive=user，其余玩家一律牌背）。
        toPlayer: user,
        onArrive: () => {
          if (SGS.Equipment) SGS.Equipment.unmount(target, weapon.id);
          user.hand.push(weapon);
          game.ui.render(game);
        }
      });
      if (game.onEquipmentLost) await game.onEquipmentLost(target, weapon);
      log(user.name + ' 获得 ' + target.name + ' 的【' + weapon.name + '】，加入手牌。', 'sys');
    }
  }

  /**
   * 五谷丰登：从牌堆顶亮出等同「现存角色数」的牌，从使用者起按逆时针
   * （game.players 数组顺序）依次每名角色挑一张获得。玩家走 ui.waitWugu()
   * 独立面板（一栏正面牌、点一下即选，无需确认），AI 直接按价值挑一张。
   * 选走的牌飞入对应角色手牌；若有剩余（牌堆不足）则进弃牌堆。
   */
  async function resolveWugu(game, user, targets, card, wxCtx) {
    const alive = (targets || []).filter((p) => !p.isDead());
    if (!alive.length) return;
    const start = game.players.indexOf(user);
    const order = [];
    for (let k = 0; k < game.players.length; k++) {
      const p = game.players[(start + k) % game.players.length];
      if (alive.indexOf(p) >= 0) order.push(p);
    }
    const pool = game.deck.draw(order.length);
    if (!pool.length) {
      log('牌堆与弃牌堆都已空，【五谷丰登】无牌可亮。', 'warn');
      return;
    }
    log(user.name + ' 从牌堆顶亮出 ' + pool.length + ' 张牌：' +
      pool.map((c) => '【' + c.name + '】').join('、') + '。', 'trick');
    // ★ 面板一次亮出、全程保留：每人依次选牌时其他人也能看着
    if (game.ui && typeof game.ui.openWugu === 'function') {
      game.ui.openWugu(game, pool);
    }
    // ★「轮到 xx 选牌」写在五谷面板内下方：结算一开始就显示，
    //   且必须早于该目标的【无懈可击】询问。面板会盖住全局引导提示区，
    //   所以这条状态条是玩家判断「要不要无懈当前目标」的唯一可见依据。
    const showWuguTurn = (t, i) => {
      if (game.ui && typeof game.ui.setWuguTurn === 'function') {
        game.ui.setWuguTurn(t.name, i + 1, order.length);
      }
    };
    if (order.length) showWuguTurn(order[0], 0);
    game.ui.render(game);
    await SGS.sleep(200);

    for (let i = 0; i < order.length && pool.length; i++) {
      const t = order[i];
      // ★ 五谷丰登也是按座次逐个结算，逐目标询问无懈；被无懈者本轮不拿牌
      if (game.isEffectNegated(wxCtx, t)) continue;
      // ★ 在 askWuXie 之前刷新面板下方的当前结算者，保证无懈询问弹出时
      //   「轮到 xx 选牌」已经可见（全局 #hint 此时被面板遮挡）。
      showWuguTurn(t, i);
      if (wxCtx && await game.askWuXie(wxCtx, t, user)) continue;
      let picked = null;
      if (SGS.isDecider(t) && game.ui && typeof game.ui.waitWugu === 'function') {
        const id = await game.ui.waitWugu(game, t, card, pool.slice(), i + 1, order.length);
        if (id) picked = pool.find((c) => c.id === id) || null;
      }
      if (!picked) picked = aiPickWugu(t, pool);
      const idx = pool.indexOf(picked);
      if (idx >= 0) pool.splice(idx, 1);
      // ★ 牌不消失，只在面板上标「已被 XX 拿走」，后续角色不能再选
      if (game.ui && typeof game.ui.markWuguTaken === 'function') {
        game.ui.markWuguTaken(picked.id, t.name);
      }
      await game.presentCard(picked, user, {
        dest: t.isHuman ? 'hand' : 'ai-hero',
        toPlayer: t,                     // ★ 获得者：只有 t 与使用者看正面
        // ★ 五谷丰登的牌是当众亮在面板上的 → 全场公开，
        //   飞牌对所有人显示正面（不受「提供者/获得者」限制）。
        public: true,
        onArrive: () => { t.hand.push(picked); game.ui.render(game); }
      });
      log(t.name + ' 获得【' + picked.name + '】。', 'sys');
      await SGS.sleep(160);
    }
    if (game.ui && typeof game.ui.closeWuguPanel === 'function') {
      game.ui.closeWuguPanel();
    }
    if (pool.length) game.deck.discard(pool);
  }

  /** AI 五谷选牌：回血 / 过牌 > 杀 > 闪 > 其余 */
  function aiPickWugu(player, pool) {
    const rank = {
      tao: 10, wuzhong: 9, wugufengdeng: 8, jiu: 7,
      sha: 6, huosha: 6, leisha: 6, shan: 5, tiesuolianhuan: 4
    };
    return pool.slice().sort((a, b) =>
      (rank[b.type] || 3) - (rank[a.type] || 3))[0];
  }

  /**
   * 铁索连环：对每名目标分别切换连环状态 —— 未横置则横置，已横置则重置。
   * 状态存在 player.chained 上，跨回合保持；角色框中央的锁链由 ui.render 绘制。
   */
  async function resolveTiesuo(game, user, targets, card, wxCtx) {
    for (const t of targets) {
      if (!t || t.isDead()) continue;
      // ★ 铁索连环对每名目标分别询问无懈；重铸不是使用，不进这个函数
      if (game.isEffectNegated(wxCtx, t)) continue;
      if (wxCtx && await game.askWuXie(wxCtx, t, user)) continue;
      const chained = typeof t.toggleChain === 'function'
        ? t.toggleChain() : (t.chained = !t.chained);
      if (SGS.log) {
        SGS.log(t.name + (chained
          ? ' 被横置，进入连环状态。' : ' 被重置，解除连环状态。'), 'trick');
      }
      game.ui.render(game);
      await SGS.sleep(220);
    }
  }

  /**
   * 使用一张锦囊牌，完成全部结算。
   * @returns {Promise<boolean>} 是否成功使用（false = 被拒绝或玩家取消，出牌阶段继续等待）
   */
  async function use(game, user, card, opts) {
    opts = opts || {};
    const check = canUse(game, user, card);
    if (!check.ok) {
      log(check.reason, 'warn');
      return false;
    }

    // ① 目标解析：other 显式点一名；all / all-others 自动全体并一对多画黄线；
    //    self 只对自己。取消（空数组）则牌留在手里、不消耗。
    const chosen = await game.selectTargets(user, card, check.targets);
    if (!chosen || !chosen.length) return false;
    const target = chosen[0];
    const mode = SGS.Cards.targetOf(card.type).mode;
    // ★ 非延时锦囊共用一份无懈上下文；单体在生效前问一次，群体在各自函数里逐个问。
    //   延时锦囊在使用时置入判定区，无懈留到该角色判定阶段、亮判定牌前再问。
    const wxCtx = game.createWuXieCtx(card, user, chosen.length);
    const singleMode = mode === 'other' || mode === 'self' ||
      mode === 'any' || mode === 'borrow';
    let singleBlocked = false;   // 询问时机见下方：飞牌 / 黄线动画结束之后

    // ② 锦囊牌先平滑飞入展示区，再离手。普通锦囊进弃牌堆；
    //    延时锦囊则置入目标的判定区（闪电的伤害来源记在牌上，传到下家后仍保留）。
    // ★ opts.realCard：【火计】把红色「牌」当【火攻】时，card 只是「当作牌」，
    //   飞牌 / 离手 / 进弃牌堆仍用原来的实体牌，弃牌堆不会混进假火攻。
    const real = opts.realCard || card;
    // ★【连环】：♣ 牌当【铁索连环】使用时写发动记录，UI.log 兜底播
    //   技能大字 + SHU-PangTong_LianHuan.webm（真铁索多连一人的记录在
    //   Game.selectTargets 里写，两处不会重复）。
    if (card.type === 'tiesuolianhuan' && opts.skillName) {
      log(user.name + ' 发动【' + opts.skillName + '】，将【' + real.name +
        '】当【铁索连环】使用。', 'sys');
    }
    await game.presentCard(real, user, {
      dest: 'showcase', asName: opts.asName || null
    });
    const isDelayed = SGS.Cards.isDelayed(card.type);
    if (isDelayed) {
      // 延时锦囊：离手后直接置入判定区，不进弃牌堆
      user.removeCard(real.id);
      real.delayedSource = user;
      SGS.Zones.addDelayed(target, real);
    } else {
      // ★ 统一离场：素材可能是装备区的「牌」（【火计】把红装备当火攻），
      //   由 Game.discardConsumed() 取走 + 弃置 + 结算失去装备。
      await game.discardConsumed(user, real);
    }
    if (game.noteUsedCard) {
      await game.noteUsedCard(user, real, {
        asType: opts.asType || card.type,
        suit: opts.suit || undefined
      });
    }

    const targetText = mode === 'self'
      ? '（对自己，无需选择目标）'
      : mode === 'other'
        ? '，目标是 ' + target.name
        : mode === 'borrow'
          ? '，借刀目标是 ' + target.name + '，【杀】目标是 ' + (chosen[1] || {}).name
          : '，目标是 ' + chosen.map((p) => p.name).join('、');
    log(user.name + ' 使用【' + card.name + '】' + targetText + '。', 'trick');
    if (isDelayed) {
      log('【' + card.name + '】置入 ' + target.name + ' 的判定区，待其判定阶段结算。', 'sys');
    }
    game.ui.render(game);
    await SGS.sleep(220);

    // ★【无懈可击】在目标锦囊的使用动画（飞入展示区 + 黄线）全部结束后、
    //   效果真正生效之前才询问：展示区里先有目标锦囊，之后才飞入无懈。
    if (!SGS.Cards.isDelayed(card.type) && singleMode) {
      singleBlocked = await game.askWuXie(wxCtx, target, user);
    }

    if (!singleBlocked) {
      if (card.type === 'wuzhong') {
        // ③ 无中生有：摸两张牌（走 drawCards 的背面叠放摸牌动画；
        //    摸牌堆空时 Deck 会自动洗回弃牌堆）
        const got = await game.drawCards(user, 2);
        log(user.name + ' 摸了 ' + got.length + ' 张牌。', 'sys');

      } else if (card.type === 'guohe' || card.type === 'shunshou') {
        // ④⑤ 过河拆桥 / 顺手牵羊：弹目标牌区面板，选中的那张才结算。
        //    可来自手牌区、装备区四槽或判定区，取牌时已从对应区域移除。
        const entry = await pickTargetCard(game, user, target, card);
        if (entry && card.type === 'guohe') {
          await game.presentCard(entry.card, target, {
            from: 'hero', dest: 'showcase', note: '过河拆桥弃置'
          });
          game.deck.discard(entry.card);
          log(user.name + ' 弃置了 ' + target.name + ' 的【' +
            SGS.Zones.zoneText(entry) + '·' + entry.card.name + '】。', 'sys');
          game.ui.render(game);   // 装备区 / 判定区立即空出来
        } else if (entry) {
          await game.presentCard(entry.card, target, {
            from: 'hero', dest: user.isHuman ? 'hand' : 'ai-hero',
            // ★ 获得者显式下发：联机层按座位号判「谁能看正面」
            //   （provide=target / receive=user，其余玩家一律牌背）。
            toPlayer: user,
            // ★ 玩家自己获得牌：一律正面插入手牌区（与摸牌同款 FLIP 动画）；
            //   AI 获得牌仍按来源明暗区分（暗手牌背面朝上，装备/判定区明牌正面）。
            faceDown: user.isHuman ? false : !entry.faceUp,
            onArrive: () => {
              user.hand.push(entry.card);
              game.ui.render(game);
            }
          });
          log(user.name + ' 获得 ' + target.name + ' 的【' +
            SGS.Zones.zoneText(entry) + '·' + entry.card.name + '】，加入手牌。', 'sys');
        }

        // ★ 拆掉 / 牵走装备区的牌，也算「失去装备区里的牌」：白银狮子回血
        if (entry && entry.zone === 'equip' && game.onEquipmentLost) {
          await game.onEquipmentLost(target, entry.card);
        }

      } else if (card.type === 'wanjian') {
        await resolveAOE(game, user, chosen, 'shan', '万箭齐发', wxCtx);

      } else if (card.type === 'nanman') {
        await resolveAOE(game, user, chosen, 'sha', '南蛮入侵', wxCtx);

      } else if (card.type === 'taoyuan') {
        await resolveTaoyuan(game, chosen, user, wxCtx);

      } else if (card.type === 'juedou') {
        await resolveDuel(game, user, target, wxCtx);

      } else if (card.type === 'huogong') {
        await resolveHuogong(game, user, target, card, wxCtx);

      } else if (card.type === 'jiedaosharen') {
        await resolveBorrow(game, user, target, chosen[1], card, wxCtx);

      } else if (card.type === 'wugufengdeng') {
        await resolveWugu(game, user, chosen, card, wxCtx);

      } else if (card.type === 'tiesuolianhuan') {
        await resolveTiesuo(game, user, chosen, card, wxCtx);
      }
    } else if (SGS.log) {
      log('【' + card.name + '】被【无懈可击】抵消，对 ' + target.name + ' 的效果不生效。', 'trick');
    }

    game.ui.render(game);
    await SGS.sleep(240);
    // 展示区保留到回合结束，由 Game.runTurn 统一清空
    return true;
  }

  SGS.Tricks = {
    specs: SPECS,
    isTrick: (type) => !!SPECS[type],
    needsTarget: needsTarget,
    targetsFor: targetsFor,
    canUse: canUse,
    use: use
  };
})(typeof window !== 'undefined' ? window : globalThis);
