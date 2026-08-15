(() => {
  'use strict';

  // The game uses Math.imul once per seed character and twice per seeded RNG call.
  // This hook must run before the game's ES modules initialize.
  const nativeImul = Math.imul;
  let imulCalls = 0;
  Math.imul = function yakyoCountedImul(a, b) {
    imulCalls++;
    return nativeImul(a, b);
  };

  const PANEL_ID = 'yakyo-event-solver';
  const BUTTON_MARK = 'data-yakyo-solver-mark';
  let queued = false;
  let lastSignature = '';

  function currentSeed() {
    const fromUrl = new URLSearchParams(location.search).get('seed');
    if (fromUrl) return fromUrl;

    const text = document.body ? document.body.innerText : '';
    const match = text.match(/(?:^|\n)\s*SEED\s+([^\s]+)/i);
    return match ? match[1].trim() : '';
  }

  function rngAt(seed, index) {
    let state = 1779033703 | 0;
    for (let i = 0; i < seed.length; i++) {
      state = nativeImul(state ^ seed.charCodeAt(i), 3432918353);
      state = (state << 13) | (state >>> 19);
    }

    let value = 0;
    for (let i = 0; i <= index; i++) {
      state |= 0;
      state = (state + 0x6D2B79F5) | 0;
      let t = nativeImul(state ^ (state >>> 15), 1 | state);
      t = (t + nativeImul(t ^ (t >>> 7), 61 | t)) ^ t;
      value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return value;
  }

  function visibleActionButtons() {
    return [...document.querySelectorAll('#act button')]
      .filter((button) => !button.disabled && button.offsetParent !== null);
  }

  function eventButtons() {
    const visible = visibleActionButtons();

    const find = (label) => visible.find((button) => button.innerText.trim().startsWith(label));
    const bold = find('全力一搏');
    const normal = find('照常執行');
    const safe = find('保守應對');
    return bold && normal && safe ? { bold, normal, safe } : null;
  }

  function romanceChoice() {
    const visible = visibleActionButtons();
    const find = (label) => visible.find((button) => button.innerText.trim().startsWith(label));
    const pair = (type, primary, secondary) => primary && secondary
      ? { type, primary, secondary }
      : null;

    return pair('confess', find('大方承認'), find('笑而不答'))
      || pair('dating-affair', find('讓她上車'), find('「不順路。'))
      || pair('married-affair', find('赴約（賭一把）'), visible.find((button) => !button.innerText.trim().startsWith('赴約（賭一把）')))
      || pair('married-apology', find('跪著道歉'), find('簽字離婚'))
      || pair('dating-apology', find('道歉，求她再給一次機會'), find('坦然分手'))
      || pair('proposal', find('就是現在——求婚'), find('再存一點錢吧'));
  }

  function rateOf(button) {
    const match = button.innerText.match(/成功率\s*(\d+(?:\.\d+)?)%/);
    return match ? Number(match[1]) / 100 : NaN;
  }

  function clearMarks() {
    document.querySelectorAll(`[${BUTTON_MARK}]`).forEach((button) => {
      button.removeAttribute(BUTTON_MARK);
      button.style.removeProperty('outline');
      button.style.removeProperty('outline-offset');
      button.style.removeProperty('box-shadow');
    });
  }

  function mark(button, color) {
    button.setAttribute(BUTTON_MARK, '1');
    button.style.setProperty('outline', `4px solid ${color}`, 'important');
    button.style.setProperty('outline-offset', '-4px', 'important');
    button.style.setProperty('box-shadow', `0 0 0 3px ${color}55`, 'important');
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
    clearMarks();
    lastSignature = '';
  }

  function status(label, succeeds, rate) {
    const icon = succeeds ? '✅' : '❌';
    return `${label} ${icon}（${Math.round(rate * 100)}%）`;
  }

  function disciplineHint(gameState, safeWins) {
    if (!gameState) return safeWins
      ? '本張選保守可增加 1 次成功計數。'
      : '本張保守也失敗，無法增加成功計數。';
    if (gameState.traits?.disc) return '已解鎖；後續事件可以直接選能成功的最大倍率。';

    const count = Number(gameState.cntSaveWin || 0);
    const missing = Math.max(0, 15 - count);
    if (gameState.love?.caught > 0) {
      return `目前 ${count}/15，還差 ${missing} 次；但已有外遇／劈腿被抓紀錄，這局已無法解鎖。`;
    }
    if (gameState.age >= 25) {
      return `目前 ${count}/15，還差 ${missing} 次；25 歲期限已過。`;
    }
    if (!safeWins) {
      return `目前 ${count}/15，還差 ${missing} 次；本張保守也失敗，不能計次。`;
    }

    const after = Math.min(15, count + 1);
    const afterMissing = Math.max(0, 15 - after);
    if (afterMissing === 0) {
      return `目前 ${count}/15，還差 1 次；本張選保守成功後立即達成 15/15。`;
    }
    return `目前 ${count}/15，還差 ${missing} 次；本張選保守成功後為 ${after}/15，之後還差 ${afterMissing} 次。`;
  }

  function romanceDisciplineStatus(gameState) {
    if (!gameState) return '';
    if (gameState.traits?.disc) return '自律狂已解鎖，之後被抓不會移除特性。';
    const count = Number(gameState.cntSaveWin || 0);
    const missing = Math.max(0, 15 - count);
    if (gameState.love?.caught > 0) return `自律狂：${count}/15；已有被抓紀錄，這局已無法解鎖。`;
    if (gameState.age >= 25) return `自律狂：${count}/15，還差 ${missing} 次；期限已過。`;
    return `自律狂：${count}/15，還差 ${missing} 次；外遇／劈腿被抓必須維持 0 次。`;
  }

  function renderRomance(panel, romance, roll, usedRngCalls, gameState) {
    const fixed = `<div>下一個固定值：<code style="font-weight:700">${roll.toFixed(6)}</code>　RNG #${usedRngCalls}</div>`;
    let result = '';

    if (romance.type === 'confess') {
      const accepted = roll < 0.65;
      const recommended = accepted ? romance.primary : romance.secondary;
      mark(recommended, '#167542');
      result = [
        fixed,
        accepted
          ? '<div>大方承認 ✅：她也會公開承認，正式交往並獲得體力收益。</div>'
          : '<div>大方承認 ❌：她會透過經紀公司否認；選笑而不答可避免尷尬。</div>',
        `<div style="color:#126b3b;font-weight:800">最佳選擇：${accepted ? '大方承認' : '笑而不答'}</div>`
      ].join('');
    } else if (romance.type === 'dating-affair' || romance.type === 'married-affair') {
      const escaped = roll < 0.55;
      mark(romance.secondary, '#167542');
      if (escaped) mark(romance.primary, '#b7791f');
      result = [
        fixed,
        escaped
          ? '<div style="color:#8a5a10">赴約／上車：這次固定不會被抓，短期體力 +2，但外遇次數 +1，會增加外務纏身風險。</div>'
          : '<div style="color:#a33128;font-weight:700">赴約／上車：這次固定會被抓，扣能力並造成分手／婚姻危機。</div>',
        '<div style="color:#126b3b;font-weight:800">長期最佳：拒絕邀約（體力 +1、零外遇、零被抓風險）</div>',
        escaped ? '<div style="font-size:13px;color:#8a5a10">橘框是短期數值較高但有隱藏代價的選項。</div>' : ''
      ].join('');
    } else if (romance.type === 'married-apology' || romance.type === 'dating-apology') {
      const apologyWorks = roll < 0.40;
      const recommended = apologyWorks ? romance.primary : romance.secondary;
      mark(recommended, apologyWorks ? '#167542' : '#b63b32');
      result = [
        fixed,
        apologyWorks
          ? '<div>道歉 ✅：固定成功，可以保住婚姻／感情。</div>'
          : '<div>道歉 ❌：固定失敗，還會再扣一項能力；直接分手／簽字可避免第二次扣能力。</div>',
        `<div style="font-weight:800;color:${apologyWorks ? '#126b3b' : '#a33128'}">最佳選擇：${apologyWorks ? '道歉挽回' : (romance.type === 'married-apology' ? '簽字離婚' : '坦然分手')}</div>`
      ].join('');
    } else if (romance.type === 'proposal') {
      mark(romance.primary, '#167542');
      result = [
        '<div>求婚沒有成功率判定：固定結婚、體力收益，並使本季受傷率 −5%。</div>',
        '<div style="color:#126b3b;font-weight:800">最佳選擇：就是現在——求婚</div>'
      ].join('');
    }

    panel.innerHTML = [
      '<div style="font-weight:800;font-size:17px;margin-bottom:3px">感情／外遇固定結果</div>',
      result,
      `<div style="font-size:13px;opacity:.82">${romanceDisciplineStatus(gameState)}</div>`
    ].join('');
  }

  async function render() {
    queued = false;
    const buttons = eventButtons();
    const romance = buttons ? null : romanceChoice();
    if (!buttons && !romance) {
      removePanel();
      return;
    }

    const seed = currentSeed();
    if (!seed) return;

    const usedRngCalls = (imulCalls - seed.length) / 2;
    const synchronized = Number.isInteger(usedRngCalls) && usedRngCalls >= 0;
    const choiceSignature = buttons
      ? `${buttons.bold.innerText}|${buttons.normal.innerText}|${buttons.safe.innerText}`
      : `${romance.type}|${romance.primary.innerText}|${romance.secondary.innerText}`;
    const signature = `${seed}|${imulCalls}|${choiceSignature}`;
    if (signature === lastSignature) return;
    lastSignature = signature;

    document.getElementById(PANEL_ID)?.remove();
    clearMarks();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'margin:0 0 14px',
      'padding:13px 15px',
      'border:2px solid #315c43',
      'background:#f4f0df',
      'color:#1f2e24',
      'font-size:15px',
      'line-height:1.65',
      'letter-spacing:.04em'
    ].join(';');

    if (!synchronized) {
      panel.innerHTML = [
        '<b style="color:#a33128">⚠ RNG 未同步</b><br>',
        '擴充套件必須在遊戲頁載入前啟用。請重新整理後從種子開局，不能在一局中途安裝。'
      ].join('');
      document.querySelector('#act')?.prepend(panel);
      return;
    }

    const roll = rngAt(seed, usedRngCalls);
    const gameState = await import('/src/core/state.js').then((module) => module.S).catch(() => null);
    if (romance) {
      renderRomance(panel, romance, roll, usedRngCalls, gameState);
      document.querySelector('#act')?.prepend(panel);
      return;
    }

    const rates = {
      bold: rateOf(buttons.bold),
      normal: rateOf(buttons.normal),
      safe: rateOf(buttons.safe)
    };
    if (Object.values(rates).some(Number.isNaN)) {
      panel.innerHTML = '<b style="color:#a33128">⚠ 無法讀取事件成功率</b>';
      document.querySelector('#act')?.prepend(panel);
      return;
    }

    const wins = {
      bold: roll < rates.bold,
      normal: roll < rates.normal,
      safe: roll < rates.safe
    };

    let bestKey;
    let bestLabel;
    if (wins.bold) {
      bestKey = 'bold';
      bestLabel = '全力一搏';
    } else if (wins.normal) {
      bestKey = 'normal';
      bestLabel = '照常執行';
    } else {
      bestKey = 'safe';
      bestLabel = '保守應對';
    }

    const unavoidable = !wins.bold && !wins.normal && !wins.safe;
    mark(buttons[bestKey], unavoidable ? '#b63b32' : '#167542');

    const discipline = disciplineHint(gameState, wins.safe);

    panel.innerHTML = [
      '<div style="font-weight:800;font-size:17px;margin-bottom:3px">全路線事件解答</div>',
      `<div>固定值：<code style="font-weight:700">${roll.toFixed(6)}</code>　RNG #${usedRngCalls}</div>`,
      `<div>${status('全力一搏', wins.bold, rates.bold)}　${status('照常', wins.normal, rates.normal)}　${status('保守', wins.safe, rates.safe)}</div>`,
      unavoidable
        ? '<div style="color:#a33128;font-weight:800">三種皆敗：選保守應對，把減益與受傷風險降到最低。</div>'
        : `<div style="color:#126b3b;font-weight:800">最大收益：${bestLabel}</div>`,
      `<div style="font-size:13px;opacity:.82">自律狂：${discipline}</div>`
    ].join('');

    document.querySelector('#act')?.prepend(panel);
  }

  function scheduleRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(render);
  }

  const observer = new MutationObserver(scheduleRender);
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleRender();
  };

  if (document.documentElement) start();
  else addEventListener('DOMContentLoaded', start, { once: true });
})();
