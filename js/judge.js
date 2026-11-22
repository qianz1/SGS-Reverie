/**
 * judge.js
 * 判定系统（纯流程层，不直接操作 DOM；展示交给 ui.js）。
 *
 * ── 标准判定流程 ────────────────────────────────────────────
 *  ① 亮出：翻开牌堆顶 1 张作为判定牌 → 放进**展示区**
 *  ② 结算改判：依次询问 SGS.Judge.modifiers（司马懿【鬼才】、张角【鬼道】
 *     等将来注册）。若某次改判给出了新判定牌，旧牌弃入弃牌堆，新牌同样
 *     放进展示区（标「改判牌」），然后继续询问后续改判。
 *  ③ 结算判定效果：由调用方的 opts.isEffective(card, color) 决定生效与否；
 *     在展示区那张（改判后的）判定牌上做标记动画：
 *       生效 → 绿色对号 + 绿色「生效」；失效 → 红色叉号 + 红色「失效」
 *     动画由 ui.markJudgeResult(effective) 触发，CSS 负责绘制。
 *  ④ 判定牌弃入弃牌堆（改判时被换掉的旧牌也在第 ② 步即时弃置）。
 *
 * 展示区只是「亮出」的视觉，不影响展示区最多 5 张 / 回合结束清空的规则；
 * 判定牌本身总是进弃牌堆，回合末可能被洗回牌堆，与原版一致。
 *
 * ── 改判接口（预留，当前为空） ────────────────────────────────
 *   SGS.Judge.modifiers.push({
 *     name: '鬼才',
 *     // async，返回新的判定牌对象表示改判；返回 null / false 表示不干预。
 *     // 改判牌由 modifier 自己负责取得（手牌 / 牌堆等）并从原区域移除。
 *     async modify(game, player, card, ctx) { ... }
 *   });
 *   ctx = { reason, player, card, color }。多个 modifier 按注册顺序依次结算，
 *   后注册的能看到前面改判后的结果 —— 与原版「改判可连环」一致。
 *
 * 本作目前没有改判角色，数组为空，但【八卦阵】已经完整走完这套流程，
 * 将来加入司马懿 / 张角时不需要改动八卦阵的任何代码。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  const log = (msg, cls) => { if (SGS.log) SGS.log(msg, cls); };

  /** 判定牌是否红色：优先读牌实例 color，缺省按花色补（手工构造的测试牌也能用） */
  function isRed(card) {
    if (!card) return false;
    if (card.color) return card.color === 'red';
    return card.suit === '\u2665' || card.suit === '\u2666';   // ♥ ♦
  }

  function colorOf(card) { return isRed(card) ? 'red' : 'black'; }
  function colorName(card) { return isRed(card) ? '红色' : '黑色'; }

  /** 登记改判技能（预留） */
  const modifiers = [];
  function addModifier(m) {
    if (m && typeof m.modify === 'function') modifiers.push(m);
    return m;
  }

  /**
   * 执行一次判定。
   * @param {object} game   Game 实例（提供 deck / ui / players）
   * @param {object} player 判定所属角色（改判时供 modifier 使用）
   * @param {object} opts
   *   reason      判定原因（写日志，如 '八卦阵'）
   *   isEffective (card, color) => bool，缺省 = 判定结果为红色
   *   needColor   'red' | 'black'，仅用于日志文案
   * @returns {Promise<object|null>} {card, color, effective, modified, reason}
   *          牌堆与弃牌堆全空时返回 null（无法判定）
   */
  async function run(game, player, opts) {
    opts = opts || {};
    const reason = opts.reason || '判定';
    const ui = game && game.ui;
    const sleep = SGS.sleep || (() => Promise.resolve());

    // ① 亮出判定牌
    const drawn = game.deck.draw(1);
    if (!drawn.length) {
      log('牌堆与弃牌堆都已空，无法进行【' + reason + '】判定。', 'warn');
      return null;
    }
    let card = drawn[0];
    let modified = false;
    const allShown = [card];

    log(player.name + ' 进行【' + reason + '】判定，亮出判定牌【' +
      (card.rank || '') + (card.suit || '') + ' ' + (card.name || '') + '】。', 'sys');
    if (ui && typeof ui.showJudgeCard === 'function') {
      await ui.showJudgeCard(card, '判定牌');
      await sleep(280);
    }

    // ② 结算改判（当前无 modifier，流程已为将来预留）
    for (const m of modifiers) {
      const ctx = { reason: reason, player: player, card: card, color: colorOf(card) };
      const replacement = await m.modify(game, player, card, ctx);
      if (!replacement || replacement === card) continue;
      game.deck.discard(card);                  // 被改掉的旧判定牌立即弃置
      card = replacement;
      modified = true;
      allShown.push(card);
      log((m.name || '改判') + '将判定牌改为【' +
        (card.rank || '') + (card.suit || '') + ' ' + (card.name || '') + '】。', 'sys');
      if (ui && typeof ui.showJudgeCard === 'function') {
        await ui.showJudgeCard(card, '改判牌');
        await sleep(280);
      }
    }

    // ③ 结算判定效果 + 展示区标记动画
    const color = colorOf(card);
    const effective = typeof opts.isEffective === 'function'
      ? !!opts.isEffective(card, color)
      : color === (opts.needColor || 'red');
    log('【' + reason + '】判定结果为' + colorName(card) + '，' +
      (effective ? '生效' : '失效') + '。', effective ? 'heal' : 'warn');
    if (ui && typeof ui.markJudgeResult === 'function') {
      await ui.markJudgeResult(effective);
      await sleep(360);
    }

    // ④ 最终判定牌弃入弃牌堆（改判换下的旧牌已在第 ② 步弃置）
    game.deck.discard(card);
    if (ui && typeof ui.render === 'function') ui.render(game);

    return {
      card: card,
      color: color,
      effective: effective,
      modified: modified,
      reason: reason,
      shown: allShown
    };
  }

  SGS.Judge = {
    modifiers: modifiers,
    addModifier: addModifier,
    isRed: isRed,
    colorOf: colorOf,
    colorName: colorName,
    run: run
  };
})(typeof window !== 'undefined' ? window : globalThis);
