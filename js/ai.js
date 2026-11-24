/**
 * ai.js
 * 简易 AI：出牌阶段吃桃 / 用锦囊 / 出杀，响应杀时找闪，弃牌阶段保留高价值牌。
 * 所有选牌都通过 player 的技能钩子，因此 AI 也能正确使用【龙胆】等转化技能；
 * 锦囊使用前会走 SGS.Tricks.canUse() 的目标与距离校验。
 *
 * ★【杀】落地预检：距离判定会因坐骑（±1 马）/ 武器攻击范围变化，
 *   AI 在喝【酒】或进入出杀循环前，必须先用与真实出杀完全一致的
 *   Game.listTargets(..., 'sha') 确认「确实有能打到的目标」，并跳过会被
 *   【仁王盾】/【藤甲】完全无效的杀，避免加伤与手牌被白白浪费。
 */
(function (global) {
  const SGS = global.SGS || (global.SGS = {});

  class AI {
    constructor(game) {
      this.game = game;
    }

    /**
     * 【龙魂】这类「按花色 / 场景」的主动转化：找到第一个符合 scenes + to
     * 的转化项，再从「牌」范围（手牌 + 装备区，不含判定区）挑一张可转化素材。
     * AI 不需要点技能按钮，但走的仍是 Player.canUseAsType() 的同一套复核，
     * 因此不会绕过技能把普通牌乱转化；装备区素材离场由 Game.discardConsumed()
     * 统一处理。
     */
    pickConverted(player, scenes, to) {
      const conv = (player.skill && player.skill.conversions || []).find(
        (c) => (c.scenes || []).indexOf(scenes) >= 0 && c.to === to
      );
      if (!conv || typeof player.canUseAsType !== 'function') return null;
      const pool = (SGS.Zones && typeof SGS.Zones.conversionCards === 'function')
        ? SGS.Zones.conversionCards(player).map((e) => e.card)
        : (player.hand || []).slice();
      const card = pool.find(
        (c) => SGS.Cards.matchesFrom(c, conv.from) && player.canUseAsType(c, to)
      );
      return card ? { card: card, conversion: conv } : null;
    }

    /** 出牌阶段 */
    async playPhase(player) {
      const g = this.game;

      // 0) 一次性主动技（【涅槃】）：角色文件自己决定时机，规则层走统一入口
      for (const action of SGS.availableSkillActions(player, 'play')) {
        const name = typeof action.aiChoice === 'function'
          ? action.aiChoice(g, player, 'play') : action.name;
        if (name !== action.name) continue;
        await g.useSkillAction(player, name, 'play');
        if (g.over) return;
        break;   // 一回合只考虑一次，避免新获得的技能把循环带飞
      }

      // 1) 受伤就吃桃（满血不吃）；★【龙魂】没有真【桃】时可用 ♥ 当【桃】
      let guard = 0;
      while (player.hp < player.maxHp && guard++ < 10) {
        const tao = player.findByType('tao')[0];
        const converted = tao ? null : this.pickConverted(player, 'play', 'tao');
        if (!tao && !converted) break;
        if (tao) {
          await g.useTao(player, tao);
        } else {
          await g.useTao(player, converted.card, {
            asName: '桃', skillName: player.skill.name
          });
        }
        await SGS.sleep(350);
        if (g.over) return;
      }

      // 2) 装备：四件都是锁定技，装上立即生效；优先填还没有装备的空槽
      //    （诸葛连弩能解除杀次数限制，所以要在出杀之前挂上）。
      guard = 0;
      while (guard++ < 6) {
        const card = player.hand.find((c) =>
          SGS.Cards.isEquip(c.type) &&
          !(player.equips && player.equips[SGS.Equipment.slotOf(c.type)])
        );
        if (!card) break;
        await g.useEquip(player, card);
        await SGS.sleep(280);
        if (g.over) return;
      }

      // 3) 用锦囊：无中生有 > 火攻 > 借刀杀人 > 桃园结义 > 顺手牵羊 >
      //    过河拆桥 > 决斗 > 万箭齐发 > 南蛮入侵。guard 兜底防止连环摸牌拖长出牌阶段。
      guard = 0;
      while (guard++ < 12) {
        const card = this.pickTrick(g, player);
        if (!card) break;
        const ok = await SGS.Tricks.use(g, player, card);
        if (!ok) break;
        await SGS.sleep(350);
        if (g.over) return;
      }

      // 3.5)【连环】：♣ 牌（含装备区）当【铁索连环】使用，走真锦囊同一个入口
      if ((player.skill.conversions || []).some((c) => c.to === 'tiesuolianhuan')) {
        const conv = this.pickConverted(player, 'play', 'tiesuolianhuan');
        if (conv) {
          const asCard = Object.assign({}, conv.card, {
            type: 'tiesuolianhuan', name: '铁索连环', viaSkill: true
          });
          if (SGS.Tricks.canUse(g, player, asCard).ok) {
            await SGS.Tricks.use(g, player, asCard, {
              realCard: conv.card, asName: '铁索连环', asType: 'tiesuolianhuan',
              skillName: '连环'
            });
            await SGS.sleep(350);
            if (g.over) return;
          }
        }
      }

      // 4) 出杀前喝【酒】：本回合限一次，为下一张【杀】伤害 +1。
      //    ★ 必须先确认这张杀真的能打出去：坐骑 / 武器会改变距离，
      //      防具也可能让杀完全无效。打不到就不喝，否则 jiuBuff 会在
      //      回合重置时被清空，白白浪费一张【酒】。
      if (!player.jiuUsed && this.canLandSha(g, player)) {
        const jiu = player.findByType('jiu')[0];
        if (jiu) {
          await g.useJiu(player, jiu);
          await SGS.sleep(300);
          if (g.over) return;
        }
      }

      // 5) 能落地才出杀（张飞 / 诸葛连弩 上限为 Infinity，会一直出到没牌）。
      //    每次循环重新预检：出掉一张杀后，剩下的牌可能全被防具挡下，
      //    或目标已阵亡，此时应立刻收手而不是空转 guard 次。
      guard = 0;
      while (guard++ < 20) {
        const card = this.pickUsableSha(g, player);
        if (!card) break;
        await g.useSha(player, card);
        await SGS.sleep(400);
        if (g.over) return;
      }

      // 6)【丈八蛇矛】：普通杀都打完后，还有出杀次数、两张以上手牌、
      //    且存在距离内目标时，把两张手牌当【杀】继续用。
      //    ★ 还有能落地的真【杀】时不用丈八（性价比低，且会白扔两张牌）；
      //      转化前逐对试算颜色，跳过会被【仁王盾】/【藤甲】完全无效的组合。
      //    AI 不需要点武器栏，直接调用与玩家同一个 Game.useZhangbaSha() 入口。
      guard = 0;
      while (guard++ < 8 && SGS.Equipment && SGS.Equipment.hasZhangba(player) &&
             player.canPlaySha() && player.hand.length >= 2 &&
             this.shaTargets(g, player).length > 0) {
        if (this.pickUsableSha(g, player)) break;   // 真杀能打 → 先打真杀
        const pair = this.pickZhangbaCards(g, player);
        if (!pair) break;                            // 所有组合都被防具挡下 → 不浪费牌
        await g.useZhangbaSha(player, pair);
        await SGS.sleep(400);
        if (g.over) return;
      }

      // 7)【龙魂】♦ 当火【杀】：真杀与丈八都用完后，仍有出杀次数且手里
      //    有 ♦ 牌时补一刀。转化杀带火焰伤害，能破【藤甲】并按火焰结算，
      //    因此预检时用「火杀」的属性去查目标防具。
      guard = 0;
      while (guard++ < 8 && player.canPlaySha() &&
             this.shaTargets(g, player).length > 0) {
        const converted = this.pickConverted(player, 'play', 'sha');
        if (!converted || !converted.conversion.asType) break;  // 只认带属性牌型的转化
        const c = converted.card;
        const eff = {
          type: converted.conversion.asType,
          damageType: SGS.Cards.damageTypeOf({ type: converted.conversion.asType }),
          color: c.color, suit: c.suit
        };
        if (!this.shaTargets(g, player).some((t) => this.shaLandsOn(player, t, eff))) break;
        await g.useSha(player, c, true, null, {
          convertTo: converted.conversion.asType,
          skillName: player.skill.name
        });
        await SGS.sleep(400);
        if (g.over) return;
      }

      // 8)【火计】红色手牌当【火攻】：目标有手牌且合法性通过才用，
      //    转化牌只用于目标判定，飞牌 / 弃置仍用原来那张红色牌。
      //    放在锦囊循环之后、出杀之前，避免占掉真锦囊的优先顺序。
      if (SGS.Tricks && typeof SGS.Tricks.use === 'function' &&
          (player.skill.conversions || []).some((c) => c.to === 'huogong')) {
        guard = 0;
        while (guard++ < 4 && !g.over) {
          const conv = this.pickConverted(player, 'play', 'huogong');
          if (!conv) break;
          const asCard = Object.assign({}, conv.card, {
            type: 'huogong', name: '火攻'
          });
          if (!SGS.Tricks.canUse(g, player, asCard).ok) break;
          const ok = await SGS.Tricks.use(g, player, asCard, {
            realCard: conv.card, asName: '火攻', asType: 'huogong',
            skillName: '火计'
          });
          if (!ok) break;
          await SGS.sleep(350);
        }
      }

      // 9)【渐营】出牌阶段限一次，把一张牌当「任意一张基本牌」使用。
      //    由角色文件的 basicChoice() 挑牌型，走与玩家同一个入口；
      //    优先挑手里价值最低的一张当素材，不要把高价值锦囊 / 桃浪费掉。
      if (!player.jianyingUsed && typeof g.useConvertedBasic === 'function' &&
          player.skill && typeof player.skill.basicChoice === 'function' &&
          player.hand.length > 1) {
        const type = player.skill.basicChoice(g, player);
        if (type) {
          const material = this.pickJianyingMaterial(player);
          if (material) {
            await g.useConvertedBasic(player, material, type);
            await SGS.sleep(350);
          }
        }
      }
    }

    /**
     * 【渐营】素材牌：优先挑「当前手里最没用」的一张（与 pickDiscards 同口径），
     * 保证不会把刚摸到的锦囊 / 桃 / 酒当素材白白转化掉。
     */
    pickJianyingMaterial(player) {
      const ids = this.pickDiscards(player, Math.min(1, player.hand.length));
      return ids.length ? player.hand.find((c) => c.id === ids[0]) : null;
    }

    /** 选一张此刻确实可用的锦囊（已过目标 / 距离校验） */
    pickTrick(game, player) {
      const priority = {
        wuzhong: 0, wugufengdeng: 0.5, huogong: 0.6,
        jiedaosharen: 0.7, tiesuolianhuan: 0.8,
        lebusishu: 0.9, bingliangcunduan: 0.95, shandian: 1,
        taoyuan: 1, shunshou: 2, guohe: 3,
        juedou: 4, wanjian: 5, nanman: 6
      };
      const list = player.hand
        .filter((c) => SGS.Cards.isTrick(c.type))
        // 规则上桃园结义全场满血也能用；AI 只是「自己满血时不白白送回血」
        // 的决策（会连对手一起治），不影响 canUse() 的合法性判定。
        .filter((c) => !(c.type === 'taoyuan' && player.hp >= player.maxHp))
        .sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9));
      return list.find((c) => SGS.Tricks.canUse(game, player, c).ok) || null;
    }

    /** 选一张能当【杀】的牌：杀家族（普通杀 / 火杀 / 雷杀）优先，其次技能转化牌 */
    pickSha(player) {
      const list = player.hand.filter((c) => player.canUseAsSha(c));
      const score = (c) => (SGS.Cards.isSha(c.type) ? 0 : 1);
      list.sort((a, b) => score(a) - score(b));
      return list[0] || null;
    }

    /**
     * 当前所有「【杀】能打到的合法目标」。
     * 直接复用 Game.listTargets(..., 'sha')，与真实出杀走的是同一套判定：
     * 座位距离 + 目标身上的 +1 马 + 自己身上的 -1 马 + 武器攻击范围，
     * 也覆盖将来扩展到多人局的情况。传 'sha' 作为 asType，龙胆把【闪】
     * 当【杀】时也会按【杀】的目标规则算，而不是牌面【闪】的 self。
     */
    shaTargets(game, player) {
      if (!game || typeof game.listTargets !== 'function') return [];
      return game.listTargets(player, { type: 'sha' }, 'sha');
    }

    /**
     * 这张杀打到该目标会不会被防具完全无效（连闪都不用问、不造成伤害）。
     * ★【朱雀羽扇】：普通【杀】可改为火【杀】，AI 会发动该「可以」技能，
     *   所以预检时按火杀属性查防具 —— 否则对手装藤甲时，AI 会误以为
     *   普通杀打不出去而不喝【酒】、不出杀，白白浪费进攻机会。
     * ★【青釭剑】：锁定技无视目标防具，任何杀都能落地。
     */
    shaLandsOn(player, target, card) {
      if (SGS.Equipment && SGS.Equipment.ignoresArmor(player)) return true;
      const eff = (card.type === 'sha' && SGS.Equipment &&
                   SGS.Equipment.weaponFlag(player, 'zhuque'))
        ? Object.assign({}, card, { damageType: 'fire' }) : card;
      return !(SGS.Equipment && SGS.Equipment.blockingArmor(target, eff));
    }

    /**
     * 「可以」类装备技能的 AI 决策（八卦阵 / 朱雀羽扇 / 寒冰剑）。
     * 八卦阵判定免费，朱雀羽扇改火杀对藤甲目标能破防，一律发动。
     * ★ 寒冰剑：能弃两张牌时才发动（比 1 点伤害划算）；只有一张可弃时
     *   宁可照常造成伤害，避免用 1 点伤害换 1 张牌。
     */
    async askOptional(player, opts) {
      opts = opts || {};
      if (opts.context === 'hanbing') {
        // 直接看「这次杀指定的目标」有几张可弃牌，多人局也不会被别人干扰
        const t = opts.target;
        const n = (t && SGS.Zones) ? SGS.Zones.disposable(t).length : 0;
        return n >= 2;
      }
      return true;
    }

    /**
     * 无懈响应：手里有【无懈可击】就使用（包括抵消别人的无懈）。
     * 「本轮不使用」只给玩家侧作为省时按钮，AI 不做整体放弃。
     */
    askWuXie(player, opts) {
      // 不对自己使用的锦囊 / 自己刚打出的无懈使用无懈，避免白白送牌
      if (opts && opts.source === player) return null;
      const real = (player.hand || []).find((c) => c.type === 'wuxiekeji');
      if (real) return real;
      // ★【龙魂】♠ 当【无懈可击】：回传转化对象，由规则层统一校验花色
      const converted = this.pickConverted(player, 'wuxie', 'wuxiekeji');
      return converted ? {
        card: converted.card, viaSkill: true,
        conversion: converted.conversion, scene: 'wuxie'
      } : null;
    }

    /**
     * 通用二选一：作为【雌雄双股剑】目标时，手牌多就弃一张、少就令对方摸牌。
     */
    async askChoice(player, opts) {
      // ★【渐营】等面板里被置灰的选项，AI 同样不能选
      const choices = ((opts && opts.choices) || []).filter((c) => !c.disabled);
      const discard = choices.find((c) => c.value === 'discard');
      const draw = choices.find((c) => c.value === 'draw');
      if (discard && player.hand.length > 2) return discard.value;
      if (draw) return draw.value;
      return choices.length ? choices[0].value : null;
    }

    /**
     * 本回合能否真正把一张【杀】打出去：
     *   ① 还有出杀次数；② 存在距离内的合法目标；
     *   ③ 手里至少有一张杀不会被该目标的防具完全挡下。
     * 【酒】只在三项都成立时才喝，避免加伤被浪费。
     */
    canLandSha(game, player) {
      if (!player.canPlaySha()) return false;
      const targets = this.shaTargets(game, player);
      if (!targets.length) return false;
      return player.hand.some((c) =>
        player.canUseAsSha(c) && targets.some((t) => this.shaLandsOn(player, t, c))
      );
    }

    /**
     * 挑一张此刻真正能落地的杀（真杀优先，其次技能转化牌）。
     * 跳过会被【仁王盾】/【藤甲】完全无效的牌：例如手里有普通杀 + 火杀、
     * 对手装藤甲时，会选火杀而不是白白打掉普通杀。
     */
    pickUsableSha(game, player) {
      if (!player.canPlaySha()) return null;
      const targets = this.shaTargets(game, player);
      if (!targets.length) return null;
      const usable = player.hand
        .filter((c) => player.canUseAsSha(c))
        .filter((c) => targets.some((t) => this.shaLandsOn(player, t, c)));
      const score = (c) => (SGS.Cards.isSha(c.type) ? 0 : 1);
      usable.sort((a, b) => score(a) - score(b));
      return usable[0] || null;
    }

    /**
     * ★【丈八蛇矛】转化前的有效性预检：穷选手牌两两组合，算出转化杀的颜色，
     *   用与真实出杀一致的 Game.listTargets() / Equipment.blockingArmor() 判断
     *   这一对能不能至少对一名目标生效。
     *   · 两黑 → 黑杀，会被【仁王盾】挡下（直接跳过）
     *   · 两红 → 红杀、一红一黑 → 无色，仁王盾都挡不住（优先两红）
     *   · 转化杀是普通杀，【藤甲】目标一律挡下；装了【青釭剑】则无视防具
     * 返回选好的两张实体牌，没有任何有效组合时返回 null（AI 不用丈八）。
     */
    pickZhangbaCards(game, player) {
      if (!SGS.Equipment || !SGS.Equipment.hasZhangba(player)) return null;
      const hand = (player.hand || []).filter(Boolean);
      if (hand.length < 2) return null;
      const targets = this.shaTargets(game, player);
      if (!targets.length) return null;
      const ignoreArmor = SGS.Equipment.ignoresArmor(player);
      const candidates = [];
      for (let i = 0; i < hand.length; i++) {
        for (let j = i + 1; j < hand.length; j++) {
          const pair = [hand[i], hand[j]];
          const color = SGS.Cards.zhangbaShaColor(pair);
          const asSha = {
            type: 'sha', name: '杀', category: 'basic',
            damageType: 'normal', color: color, suit: '', rank: '',
            zhangba: true
          };
          const lands = ignoreArmor ||
            targets.some((t) => !SGS.Equipment.blockingArmor(t, asSha));
          if (!lands) continue;
          // 两红最稳（红杀），其次一红一黑（无色），两黑只有在无视防具时才入选
          const rank = color === 'red' ? 2 : (color === null ? 1 : 0);
          candidates.push({ pair: pair, rank: rank, order: i * 100 + j });
        }
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.rank - a.rank || a.order - b.order);
      return candidates[0].pair;
    }

    /** 响应【杀】/【万箭齐发】：选一张能当【闪】的牌，真闪优先 */
    async respondSha(target) {
      const list = target.hand.filter((c) => target.canUseAsShan(c));
      const score = (c) => (c.type === 'shan' ? 0 : 1);
      list.sort((a, b) => score(a) - score(b));
      return list[0] || null;
    }

    /**
     * 通用响应：按 need 找一张能打出的牌（'shan' / 'sha'）。
     * 万箭齐发要【闪】、南蛮入侵 / 决斗要【杀】，龙胆等转化技能由
     * canUseAsShan / canUseAsSha 钩子自动包含，因此 AI 也会正确转化。
     */
    async respondNeed(player, need) {
      if (need === 'sha') {
        const real = this.pickSha(player);
        if (real) return real;
        // ★【龙魂】♦ 当火【杀】：响应南蛮入侵 / 决斗时打出的【杀】不造成伤害，
        //   按普通杀响应即可；Game.askRespond 会自动把非杀家族的牌标为转化。
        const dragon = this.pickConverted(player, 'respond', 'sha');
        if (dragon && dragon.conversion.asType) return dragon.card;
        // ★【丈八蛇矛】：没有杀时，若装了蛇矛且还有两张手牌，返回主动转化标记。
        //   Game.askRespond() 会据此调用 zhangbaRespond() 移手 / 弃置并返回虚拟响应。
        if (SGS.Equipment && SGS.Equipment.hasZhangba(player) && player.hand.length >= 2) {
          return { zhangba: true, cards: player.hand.slice(0, 2) };
        }
        return null;
      }
      const real = await this.respondSha(player);
      if (real) return real;
      // ★【龙魂】♣ 当【闪】
      const dragon = this.pickConverted(player, 'respond', 'shan');
      return dragon ? dragon.card : null;
    }

    /** 弃牌阶段：rank 越大越先被弃（等价于优先保留 锦囊 / 桃 / 酒 > 闪 > 杀） */
    pickDiscards(player, n) {
      const rank = {
        wuzhong: 0, shunshou: 0, guohe: 0, juedou: 0,
        wanjian: 0, nanman: 0, taoyuan: 0, tao: 0, jiu: 0,
        huogong: 0, jiedaosharen: 0,
        wugufengdeng: 0, tiesuolianhuan: 0,
        // 重复摸到的装备牌（同槽已装）价值低，排在闪之前先弃
        zhugeliannu: 1.5, jueying: 1.5, chitu: 1.5, renwangdun: 1.5,
        zixing: 1.5, dilu: 1.5, zhuahuangfeidian: 1.5, dayuan: 1.5, tengjia: 1.5,
        shan: 1, sha: 2,
        // 属性杀比普通杀略优先保留（rank 越大越先弃）：火杀能破【藤甲】
        huosha: 1.8, leisha: 1.8
      };
      // ★【藏拙】：本回合未用锦囊时锦囊牌不计入手牌上限，AI 弃牌应优先
      //   从「计入上限」的牌里挑 —— 否则弃了免计牌，有效张数不变，主循环
      //   会再问一次，白白多弃牌。
      const exempt = (c) => (typeof player.hook === 'function')
        ? !!player.hook('handLimitExempt', c) : false;
      const scored = player.hand.slice();
      scored.sort((a, b) => {
        const ea = exempt(a) ? 1 : 0, eb = exempt(b) ? 1 : 0;
        if (ea !== eb) return ea - eb;   // 非免计牌在前，优先弃它
        return (rank[b.type] ?? 1) - (rank[a.type] ?? 1);
      });
      return scored.slice(0, n).map((c) => c.id);
    }

    /**
     * 濒死：【桃】优先，其次【酒】（次数不限，每张回复 1 点）；
     * ★【龙魂】都没有时，可用一张 ♥ 牌当【桃】自救，回传技能转化对象，
     *   Game.brink() 会校验花色 / 技能钩子后按【桃】结算。
     */
    async brink(player) {
      const real = player.findByType('tao')[0] || player.findByType('jiu')[0];
      if (real) return real;
      const converted = this.pickConverted(player, 'brink', 'tao');
      if (converted) {
        return {
          card: converted.card, viaSkill: true,
          conversion: converted.conversion, scene: 'brink'
        };
      }
      // ★ 没桃没酒时考虑【涅槃】这类濒死一次性主动技
      for (const action of SGS.availableSkillActions(player, 'brink')) {
        const name = typeof action.aiChoice === 'function'
          ? action.aiChoice(this.game, player, 'brink') : action.name;
        if (name === action.name) {
          return { type: 'skillAction', name: name, scene: 'brink' };
        }
      }
      return null;
    }
  }

  SGS.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);
