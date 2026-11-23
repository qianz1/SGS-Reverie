/**
 * main.js
 * 启动入口：初始化界面 → 选将 → 创建对局 → 跑主循环。
 * 本作按横屏战场布局：手机竖屏时显示旋转提示，并在首次点击时尝试请求横屏。
 */
(function (global) {
  const SGS = global.SGS;

  /** 尝试锁定横屏；浏览器不支持或未获授权时静默降级为「竖屏提示」 */
  function requestLandscape() {
    try {
      const so = global.screen && global.screen.orientation;
      if (so && typeof so.lock === 'function') {
        const p = so.lock('landscape');
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) {
      // 忽略：仍由竖屏提示层引导用户旋转设备
    }
  }

  function start() {
    const ui = new SGS.UI();
    ui.init();

    // 用户明确选择竖屏查看时，关闭提示层
    const ignore = document.getElementById('btn-ignore-rotate');
    if (ignore) {
      ignore.addEventListener('click', function () {
        document.body.classList.add('allow-portrait');
      });
    }

    // 开局先选模式（目前仅开放 1v1）；借首次点击的用户手势尝试锁定横屏。
    // 2v2 / 斗地主 / 军争点击后只提示「暂未开放」，不会创建对局。
    ui.showModeScreen(function (mode) {
      requestLandscape();
      // ★ 联机面板挂在选将层；不开启时完全是原来的本地 AI 流程。
      try { if (SGS.Net && SGS.Net.attach) SGS.Net.attach(ui); } catch (e) {}
      // 选中的角色归玩家，另一个自动给 AI
      ui.showStartScreen(function (charId, netInfo) {
        // ★ 战斗 BGM：这次点击是真实用户手势，允许音频自动播放；
        //   文件缺失 / 浏览器拒绝都已在 Audio 层静默处理。
        try { if (SGS.Audio && SGS.Audio.startBgm) SGS.Audio.startBgm(); }
        catch (e) { /* 音频不可用不影响开局 */ }
        // ★ 座次按模式分派：1v1 按场上人数随机分配 1..N 序号（谁是一号位谁先手）；
        //   将来 2v2 / 斗地主 / 军争各自走 SEAT_RULES 里对应的规则。
        // ★ 联机：会话自己创建权威 Game（主机）或等 init（客机），
        //   本地仍走原来的构造路径。
        if (netInfo && netInfo.session) {
          netInfo.session.startGame(charId);
          return;
        }
        const game = new SGS.Game(ui, charId, { mode: mode });
        ui.bindGame(game);
        ui.render(game);
        ui.refreshActions(); // 开局即点亮技能框与操作区占位
        game.run(); // 内部会一直循环到分出胜负
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
