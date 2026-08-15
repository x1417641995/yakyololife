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
  const ALLOC_PANEL_ID = 'yakyo-allocation-advisor';
  const BUTTON_MARK = 'data-yakyo-solver-mark';
  const ALLOC_MARK = 'data-yakyo-alloc-mark';
  const ABILITY_LABELS = {
    sta: '體力', vel: '球速', ctl: '控球', brk: '變化球', con: 'Contact',
    pow: '力量', spd: '速度', eye: '選球', rng: '守備範圍', fld: '接球',
    arm: '臂力', cat: '配球'
  };
  const POSITION_KEYS = {
    P: ['sta', 'vel', 'ctl', 'brk'],
    C: ['sta', 'con', 'pow', 'spd', 'eye', 'rng', 'fld', 'arm', 'cat'],
    IF: ['sta', 'con', 'pow', 'spd', 'eye', 'rng', 'fld', 'arm'],
    OF: ['sta', 'con', 'pow', 'spd', 'eye', 'rng', 'fld', 'arm']
  };
  let queued = false;
  let lastSignature = '';
  let lastAllocSignature = '';
  let fallbackSafeWins = 0;
  let fallbackCaught = 0;
  const seenEventRolls = new Set();
  const eventsSeenByYear = new Map();

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

  function clearAllocationAdvisor() {
    document.getElementById(ALLOC_PANEL_ID)?.remove();
    document.querySelectorAll(`[${ALLOC_MARK}]`).forEach((row) => {
      row.removeAttribute(ALLOC_MARK);
      row.style.removeProperty('outline');
      row.style.removeProperty('outline-offset');
      row.style.removeProperty('background');
    });
    lastAllocSignature = '';
  }

  function status(label, succeeds, rate) {
    const icon = succeeds ? '✅' : '❌';
    return `${label} ${icon}（${Math.round(rate * 100)}%）`;
  }

  async function loadGameState() {
    // An absolute URL is required in a Manifest V3 MAIN-world content script.
    // A root-relative import is otherwise resolved against the extension itself.
    return import(`${location.origin}/src/core/state.js`)
      .then((module) => module.S)
      .catch(() => null);
  }

  function abilityCost(gameState, key, level) {
    const isPitcher = gameState.pos === 'P';
    let cost = isPitcher
      ? (level >= 66 ? 7 : level >= 58 ? 4 : level >= 50 ? 2 : 1)
      : (level >= 72 ? 3 : level >= 64 ? 2 : 1);
    const potential = Number(gameState.pot?.[key] ?? 62);
    if (level >= potential) cost *= isPitcher ? 4 : 3;
    return cost;
  }

  function simulateAbilitySpend(gameState, key, amount) {
    let level = Math.max(1, Math.min(80, Math.round(Number(gameState.ab?.[key]) || 1)));
    let budget = Math.max(0, Number(amount) || 0) + Math.max(0, Number(gameState.carry?.[key]) || 0);
    while (budget > 0 && level < 80) {
      const cost = abilityCost(gameState, key, level);
      if (budget < cost) break;
      budget -= cost;
      level++;
    }
    const carry = level >= 80 ? 0 : budget;
    const nextCost = level >= 80 ? 1 : abilityCost(gameState, key, level);
    return { level, carry, effective: level >= 80 ? 80 : level + carry / nextCost };
  }

  function effectiveAbilities(gameState) {
    const values = { ...gameState.ab };
    (POSITION_KEYS[gameState.pos] || []).forEach((key) => {
      const level = Number(gameState.ab?.[key]) || 1;
      const carry = Math.max(0, Number(gameState.carry?.[key]) || 0);
      const cost = level >= 80 ? 1 : abilityCost(gameState, key, level);
      values[key] = level >= 80 ? 80 : level + carry / cost;
    });
    return values;
  }

  function defenseScore(position, abilities) {
    const a = abilities;
    switch (position) {
      case 'SS': return a.rng * 0.5 + a.fld * 0.3 + a.arm * 0.2;
      case '2B': return a.rng * 0.45 + a.fld * 0.4 + a.arm * 0.15;
      case '3B': return a.arm * 0.45 + a.fld * 0.35 + a.rng * 0.2;
      case 'CF': return a.rng * 0.55 + a.fld * 0.3 + a.arm * 0.15;
      case 'RF': return a.arm * 0.45 + a.rng * 0.35 + a.fld * 0.2;
      case 'LF': return a.rng * 0.4 + a.fld * 0.35 + a.arm * 0.25;
      case 'C': return a.fld * 0.4 + a.cat * 0.4 + a.arm * 0.2;
      case '1B': return a.fld * 0.6 + a.rng * 0.2 + a.arm * 0.2;
      default: return 0;
    }
  }

  function rawOvr(gameState, abilities) {
    const a = abilities;
    if (gameState.pos === 'P') {
      const ordered = [a.vel, a.ctl, a.brk].sort((x, y) => y - x);
      return ordered[0] * 0.42 + ordered[1] * 0.30 + ordered[2] * 0.18 + a.sta * 0.10;
    }
    const offense = [a.con, a.pow, a.eye, a.spd].sort((x, y) => y - x);
    const offenseScore = offense[0] * 0.38 + offense[1] * 0.27 + offense[2] * 0.20 + offense[3] * 0.15;
    const position = gameState.dpos || (gameState.pos === 'C' ? 'C' : (gameState.pos === 'OF' ? 'CF' : 'SS'));
    const defense = position === 'DH' ? defenseScore('1B', a) - 12 : defenseScore(position, a);
    const defenseWeight = gameState.dpos
      ? ({ SS: 0.30, CF: 0.30, C: 0.30, '2B': 0.22, '3B': 0.22, RF: 0.20, '1B': 0.12, LF: 0.14, DH: 0.12 }[gameState.dpos] ?? 0.22)
      : 0.24;
    return offenseScore * (1 - defenseWeight) + defense * defenseWeight;
  }

  function displayedOvr(gameState, abilities) {
    return Math.round(rawOvr(gameState, abilities)) - (gameState.traits?.yips ? 3 : 0);
  }

  function proCore(gameState, abilities) {
    if (gameState.pos === 'P') return (abilities.vel + abilities.ctl + abilities.brk) / 3;
    return abilities.con * 0.5 + abilities.pow * 0.2 + abilities.eye * 0.18 + abilities.spd * 0.12;
  }

  function championshipProfile(gameState) {
    const level = String(gameState.lv || '');
    const org = gameState.org || (level.startsWith('CPBL') ? 'CPBL' : level.startsWith('NPB') ? 'NPB' : 'MiLB');
    const pitcher = gameState.pos === 'P';
    const effortAdjustment = pitcher
      ? ({ '全力投': 1, '普通投': 0, '養生球': -1 }[gameState.effort] || 0)
      : 0;
    return {
      CPBL: { name: '中職總冠軍', target: pitcher ? 66 - effortAdjustment : 66.5 },
      NPB: { name: '日本一', target: pitcher ? 67 - effortAdjustment : 67.5 },
      MiLB: { name: '世界大賽冠軍', target: pitcher ? 70 - effortAdjustment : 70.5 }
    }[org] || null;
  }

  function amateurGuarantee(gameState) {
    if (gameState.stage === 'HS') {
      const bonus = ({ 1: 6, 2: 0, 3: -6 })[Number(gameState.hsTier || 2)] || 0;
      return 52 - bonus + 8;
    }
    if (gameState.stage === 'U' || gameState.stage === 'AMA') return 68;
    return null;
  }

  function markAllocationRow(row) {
    row.setAttribute(ALLOC_MARK, '1');
    row.style.setProperty('outline', '3px solid #167542', 'important');
    row.style.setProperty('outline-offset', '-3px', 'important');
    row.style.setProperty('background', '#dcebd8', 'important');
  }

  function renderAllocationAdvisor(gameState) {
    const rows = [...document.querySelectorAll('#al-rows .abrow')];
    const keys = POSITION_KEYS[gameState?.pos] || [];
    if (!gameState || !rows.length || rows.length !== keys.length) return;
    if (!rows.some((row) => typeof row.onclick === 'function')) {
      clearAllocationAdvisor();
      return;
    }

    const activeDie = document.querySelector('#dice .die.active');
    const amount = activeDie ? Number(activeDie.textContent.trim()) : 1;
    const signature = [
      gameState.year, gameState.stage, gameState.lv, gameState.dpos, amount,
      ...keys.flatMap((key) => [gameState.ab?.[key], gameState.carry?.[key] || 0])
    ].join('|');
    if (signature === lastAllocSignature && document.getElementById(ALLOC_PANEL_ID)) return;
    lastAllocSignature = signature;

    document.getElementById(ALLOC_PANEL_ID)?.remove();
    rows.forEach((row) => {
      row.removeAttribute(ALLOC_MARK);
      row.style.removeProperty('outline');
      row.style.removeProperty('outline-offset');
      row.style.removeProperty('background');
    });

    const currentEffective = effectiveAbilities(gameState);
    const currentActual = { ...gameState.ab };
    const professional = gameState.stage === 'PRO';
    const currentMetric = professional ? proCore(gameState, currentEffective) : rawOvr(gameState, currentEffective);
    const candidates = keys.map((key, index) => {
      if ((Number(gameState.ab?.[key]) || 0) >= 80) return null;
      const spent = simulateAbilitySpend(gameState, key, amount);
      const effectiveAfter = { ...currentEffective, [key]: spent.effective };
      const actualAfter = { ...currentActual, [key]: spent.level };
      const metricAfter = professional ? proCore(gameState, effectiveAfter) : rawOvr(gameState, effectiveAfter);
      return {
        key,
        index,
        spent,
        gain: metricAfter - currentMetric,
        actualOvr: displayedOvr(gameState, actualAfter),
        core: proCore(gameState, effectiveAfter)
      };
    }).filter(Boolean).sort((a, b) => b.gain - a.gain || a.index - b.index);
    if (!candidates.length) return;

    const bestGain = candidates[0].gain;
    const best = candidates.filter((candidate) => Math.abs(candidate.gain - bestGain) < 0.000001);
    best.forEach((candidate) => markAllocationRow(rows[candidate.index]));

    const currentOvr = displayedOvr(gameState, currentActual);
    const topDetails = candidates.slice(0, 3).map((candidate) => {
      const levelText = candidate.spent.level > Number(gameState.ab[candidate.key])
        ? `${gameState.ab[candidate.key]}→${candidate.spent.level}`
        : `蓄力 ${candidate.spent.carry}/${abilityCost(gameState, candidate.key, candidate.spent.level)}`;
      const gainText = professional
        ? `冠軍核心 +${candidate.gain.toFixed(3)}`
        : `OVR 進度 +${candidate.gain.toFixed(3)}`;
      return `${ABILITY_LABELS[candidate.key]}（${levelText}，${gainText}）`;
    }).join('<br>');

    let objective;
    if (professional) {
      const profile = championshipProfile(gameState);
      const currentCore = proCore(gameState, currentActual);
      const gap = profile ? Math.max(0, profile.target - currentCore) : 0;
      objective = profile
        ? `目前冠軍核心 <b>${currentCore.toFixed(2)}</b>；${profile.name}機率上限目標 <b>${profile.target}</b>，還差 <b>${gap.toFixed(2)}</b>。`
        : `目前冠軍核心 <b>${currentCore.toFixed(2)}</b>。`;
    } else {
      const guarantee = amateurGuarantee(gameState);
      const gap = guarantee === null ? null : Math.max(0, guarantee - currentOvr);
      objective = guarantee === null
        ? `目前 OVR <b>${currentOvr}</b>。`
        : `目前 OVR <b>${currentOvr}</b>；本路線最差亂數保證冠軍線 <b>${guarantee}</b>，還差 <b>${gap}</b>。`;
    }

    const panel = document.createElement('div');
    panel.id = ALLOC_PANEL_ID;
    panel.style.cssText = [
      'margin:10px 0 4px',
      'padding:11px 13px',
      'border:2px solid #315c43',
      'background:#f4f0df',
      'color:#1f2e24',
      'font-size:13px',
      'line-height:1.6'
    ].join(';');
    panel.innerHTML = [
      `<div style="font-weight:800;font-size:16px">加點推薦｜本次投入 ${amount} 點</div>`,
      `<div>${objective}</div>`,
      `<div style="color:#126b3b;font-weight:800">綠框優先：${best.map((candidate) => ABILITY_LABELS[candidate.key]).join('／')}</div>`,
      `<div style="opacity:.82">本次收益前三名：<br>${topDetails}</div>`,
      '<div style="opacity:.7">每次點完會依新等級、蓄力、成本與潛力重新計算。</div>'
    ].join('');
    document.getElementById('al-top')?.appendChild(panel);
  }

  function currentStageEventTotal(gameState) {
    return gameState?.stage === 'PRO' ? 3 : 2;
  }

  function recordEvent(gameState, usedRngCalls) {
    if (!gameState) return;
    const key = `${gameState.year}:${usedRngCalls}`;
    if (seenEventRolls.has(key)) return;
    seenEventRolls.add(key);
    eventsSeenByYear.set(gameState.year, (eventsSeenByYear.get(gameState.year) || 0) + 1);
  }

  function deadlineEventRange(gameState) {
    if (!gameState || gameState.age >= 25) return null;
    const seenThisYear = eventsSeenByYear.get(gameState.year) || 1;
    const currentRemaining = Math.max(1, currentStageEventTotal(gameState) - seenThisYear + 1);
    let minimum = currentRemaining;
    let maximum = currentRemaining;

    for (let age = gameState.age + 1; age <= 24; age++) {
      const delta = age - gameState.age;
      if (gameState.stage === 'PRO') {
        minimum += 3;
        maximum += 3;
      } else if (gameState.stage === 'U' && Number(gameState.stageYr || 0) + delta <= 4) {
        minimum += 2;
        maximum += 2;
      } else if (gameState.stage === 'HS' && Number(gameState.stageYr || 0) + delta <= 3) {
        minimum += 2;
        maximum += 2;
      } else {
        // Future school/amateur routes draw 2 cards; professional routes draw 3.
        minimum += 2;
        maximum += 3;
      }
    }
    return { minimum, maximum };
  }

  function eventRangeText(range, missing) {
    if (!range) return '';
    const slots = range.minimum === range.maximum
      ? `${range.minimum}`
      : `${range.minimum}～${range.maximum}`;
    const slackMin = Math.max(0, range.minimum - missing);
    const slackMax = Math.max(0, range.maximum - missing);
    const slack = slackMin === slackMax ? `${slackMin}` : `${slackMin}～${slackMax}`;
    const impossible = range.maximum < missing
      ? '；即使後面全選保守也來不及'
      : `；若保守皆成功，理論上還可選大 ${slack} 張`;
    return `截止前剩餘事件格（含本張）：${slots}${impossible}`;
  }

  function disciplineHint(gameState, safeWins) {
    if (!gameState) {
      const missing = Math.max(0, 15 - fallbackSafeWins);
      return safeWins
        ? `狀態模組未載入，使用本機備援：${fallbackSafeWins}/15，還差 ${missing} 次；本張保守成功後為 ${Math.min(15, fallbackSafeWins + 1)}/15。`
        : `狀態模組未載入，使用本機備援：${fallbackSafeWins}/15，還差 ${missing} 次；本張保守失敗，不能計次。`;
    }
    if (gameState.traits?.disc) return '已解鎖；後續事件可以直接選能成功的最大倍率。';

    const count = Number(gameState.cntSaveWin || 0);
    const missing = Math.max(0, 15 - count);
    const rangeText = eventRangeText(deadlineEventRange(gameState), missing);
    if (gameState.love?.caught > 0) {
      return `目前 ${count}/15，還差 ${missing} 次；但已有外遇／劈腿被抓紀錄，這局已無法解鎖。`;
    }
    if (gameState.age >= 25) {
      return `目前 ${count}/15，還差 ${missing} 次；25 歲期限已過。`;
    }
    if (!safeWins) {
      return `目前 ${count}/15，還差 ${missing} 次；本張保守也失敗，不能計次。${rangeText ? `<br>${rangeText}` : ''}`;
    }

    const after = Math.min(15, count + 1);
    const afterMissing = Math.max(0, 15 - after);
    if (afterMissing === 0) {
      return `目前 ${count}/15，還差 1 次；本張選保守成功後立即達成 15/15。`;
    }
    return `目前 ${count}/15，還差 ${missing} 次；本張選保守成功後為 ${after}/15，之後還差 ${afterMissing} 次。${rangeText ? `<br>${rangeText}` : ''}`;
  }

  function romanceDisciplineStatus(gameState) {
    if (!gameState) return `自律狂（本機備援）：${fallbackSafeWins}/15，還差 ${Math.max(0, 15 - fallbackSafeWins)} 次；被抓 ${fallbackCaught} 次。`;
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
      if (!romance.primary.dataset.yakyoCaughtTracker) {
        romance.primary.dataset.yakyoCaughtTracker = '1';
        romance.primary.addEventListener('click', () => {
          if (!escaped) fallbackCaught++;
        }, { once: true });
      }
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
    const allocationRows = document.querySelectorAll('#al-rows .abrow');
    if (allocationRows.length) {
      removePanel();
      const gameState = await loadGameState();
      renderAllocationAdvisor(gameState);
      return;
    }
    clearAllocationAdvisor();
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
    const gameState = await loadGameState();
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

    recordEvent(gameState, usedRngCalls);
    if (!buttons.safe.dataset.yakyoDisciplineTracker) {
      buttons.safe.dataset.yakyoDisciplineTracker = '1';
      buttons.safe.addEventListener('click', () => {
        if (wins.safe) fallbackSafeWins++;
      }, { once: true });
    }

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
