// ─── State ────────────────────────────────────────────
let currentUser   = null;  // { id, name, daily_target }
let todayBanked   = 0;
let todayDate     = '';
let history       = [];

// Wheel state
let wheelAngle    = 0;    // visual CSS rotation
let totalAngle    = 0;    // accumulated since last bank (signed)
let pendingReps   = 0;
let isDragging    = false;
let lastPointerAngle = null;
let wheelEl       = null;
let marksGroup    = null;
let wheelCenterText = null;

// ─── API ──────────────────────────────────────────────
const API = {
  async getUser(name) {
    const r = await fetch(`/api/user/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error('Failed to load user');
    return r.json();
  },
  async bank(name, amount) {
    const r = await fetch('/api/bank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, amount })
    });
    if (!r.ok) throw new Error('Failed to bank');
    return r.json();
  },
  async updateSettings(name, target) {
    const r = await fetch(`/api/settings/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_target: target })
    });
    if (!r.ok) throw new Error('Failed to save settings');
    return r.json();
  }
};

// ─── Wheel Drawing ────────────────────────────────────
function buildWheelMarks() {
  marksGroup.innerHTML = '';
  const cx = 160, cy = 160;
  const outerR = 145;
  const totalMarks = 40; // 40 marks → every 9° → major every 4 = every 36° → 10 per rotation

  for (let i = 0; i < totalMarks; i++) {
    const isMajor = i % 4 === 0;
    const angleDeg = i * (360 / totalMarks);
    const angleRad = (angleDeg - 90) * (Math.PI / 180);

    const innerR = isMajor ? outerR - 22 : outerR - 10;
    const x1 = cx + innerR * Math.cos(angleRad);
    const y1 = cy + innerR * Math.sin(angleRad);
    const x2 = cx + (outerR - 2) * Math.cos(angleRad);
    const y2 = cy + (outerR - 2) * Math.sin(angleRad);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('stroke', isMajor ? '#a7a7a9' : '#333340');
    line.setAttribute('stroke-width', isMajor ? '2' : '1');
    line.setAttribute('stroke-linecap', 'round');
    marksGroup.appendChild(line);

    // Label every major mark (every 36° = 1 rep label)
    if (isMajor) {
      const repNum = i / 4 + 1; // 1–10
      const labelR = innerR - 14;
      const lx = cx + labelR * Math.cos(angleRad);
      const ly = cy + labelR * Math.sin(angleRad);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', lx.toFixed(2));
      text.setAttribute('y', ly.toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('fill', '#3a3a48');
      text.setAttribute('font-size', '9');
      text.setAttribute('font-family', 'Helvetica Neue, Helvetica, Arial, sans-serif');
      text.textContent = repNum === 10 ? '10' : repNum;
      marksGroup.appendChild(text);
    }
  }
}

// ─── Wheel Interaction ────────────────────────────────
function getAngle(clientX, clientY) {
  const rect = wheelEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return Math.atan2(clientY - cy, clientX - cx) * (180 / Math.PI);
}

function onPointerDown(e) {
  if (e.target.closest('#bank-btn')) return;
  isDragging = true;
  lastPointerAngle = getAngle(
    e.touches ? e.touches[0].clientX : e.clientX,
    e.touches ? e.touches[0].clientY : e.clientY
  );
  wheelEl.classList.add('spinning');
  e.preventDefault();
}

function onPointerMove(e) {
  if (!isDragging) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const angle = getAngle(clientX, clientY);

  let delta = angle - lastPointerAngle;
  // Normalise to [-180, 180] to handle wrap-around
  if (delta > 180)  delta -= 360;
  if (delta < -180) delta += 360;

  wheelAngle += delta;
  totalAngle += delta;
  lastPointerAngle = angle;

  // Update wheel visual
  wheelEl.style.transform = `rotate(${wheelAngle}deg)`;

  // Calculate pending reps: 36° per rep, 10 reps per full rotation
  const newPending = Math.floor(Math.abs(totalAngle) / 36);
  if (newPending !== pendingReps) {
    pendingReps = newPending;
    updatePendingUI();
  }
}

function onPointerUp() {
  if (!isDragging) return;
  isDragging = false;
  wheelEl.classList.remove('spinning');
}

function updatePendingUI() {
  const pendingEl  = document.getElementById('pending-count');
  const bankBtn    = document.getElementById('bank-btn');
  const bankAmount = document.getElementById('bank-amount');

  pendingEl.textContent = pendingReps;
  pendingEl.classList.toggle('zero', pendingReps === 0);
  bankBtn.disabled = pendingReps === 0;
  bankAmount.textContent = pendingReps;
  wheelCenterText.textContent = pendingReps;
}

// ─── Bank ─────────────────────────────────────────────
async function bankReps() {
  if (pendingReps === 0) return;

  const amount = pendingReps;
  const bankBtn = document.getElementById('bank-btn');
  bankBtn.disabled = true;

  try {
    const result = await API.bank(currentUser.name, amount);
    todayBanked = result.banked;

    // Reset wheel state
    totalAngle  = 0;
    pendingReps = 0;
    updatePendingUI();

    // Update progress
    updateProgressUI();
    updateHistoryRow(todayDate, todayBanked);

    // Celebrate if just hit or crossed target
    const wasBelow = (todayBanked - amount) < currentUser.daily_target;
    const isAtOrAbove = todayBanked >= currentUser.daily_target;
    if (wasBelow && isAtOrAbove) showCelebration(todayBanked);

  } catch (err) {
    console.error(err);
    bankBtn.disabled = false;
  }
}

// ─── Progress UI ──────────────────────────────────────
function updateProgressUI() {
  const bankedEl   = document.getElementById('banked-count');
  const targetEl   = document.getElementById('target-count');
  const fillEl     = document.getElementById('progress-fill');
  const target     = currentUser.daily_target;
  const pct        = Math.min((todayBanked / target) * 100, 100);

  bankedEl.textContent = todayBanked;
  targetEl.textContent = target;
  fillEl.style.width   = pct + '%';

  bankedEl.classList.toggle('at-target', todayBanked >= target);
  fillEl.classList.toggle('complete', todayBanked >= target && todayBanked < target * 1.5);
  fillEl.classList.toggle('exceeded', todayBanked >= target * 1.5);
}

// ─── History UI ───────────────────────────────────────
function renderHistory() {
  const grid   = document.getElementById('history-grid');
  const target = currentUser.daily_target;
  grid.innerHTML = '';

  // Show last 14 days, fill gaps
  const days = buildDayMap(history, 14);

  days.forEach(({ date, banked }) => {
    const pct      = Math.min((banked / target) * 100, 100);
    const complete = banked >= target;
    const exceeded = banked >= target * 1.5;

    const row = document.createElement('div');
    row.className = 'history-row';
    row.dataset.date = date;

    const dateLabel = document.createElement('span');
    dateLabel.className = 'history-date';
    dateLabel.textContent = formatDate(date);

    const barWrap = document.createElement('div');
    barWrap.className = 'history-bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'history-bar' + (exceeded ? ' exceeded' : complete ? ' complete' : '');
    bar.style.width = pct + '%';

    const count = document.createElement('span');
    count.className = 'history-count' + (complete ? ' complete' : '');
    count.textContent = banked || '';

    barWrap.appendChild(bar);
    row.appendChild(dateLabel);
    row.appendChild(barWrap);
    row.appendChild(count);
    grid.appendChild(row);
  });

  renderStreak(days);
}

function updateHistoryRow(date, banked) {
  const grid   = document.getElementById('history-grid');
  const target = currentUser.daily_target;
  const pct    = Math.min((banked / target) * 100, 100);
  const complete = banked >= target;
  const exceeded = banked >= target * 1.5;

  const existing = grid.querySelector(`[data-date="${date}"]`);
  if (existing) {
    const bar   = existing.querySelector('.history-bar');
    const count = existing.querySelector('.history-count');
    bar.style.width = pct + '%';
    bar.className = 'history-bar' + (exceeded ? ' exceeded' : complete ? ' complete' : '');
    count.textContent = banked;
    count.className = 'history-count' + (complete ? ' complete' : '');
  } else {
    renderHistory();
  }
}

function buildDayMap(histArr, numDays) {
  const map = {};
  histArr.forEach(h => { map[h.date] = h.banked; });

  const days = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    days.push({ date: key, banked: map[key] || 0 });
  }
  return days;
}

function renderStreak(days) {
  const target  = currentUser.daily_target;
  const streakEl = document.getElementById('streak-display');
  let streak = 0;

  for (const day of days) {
    if (day.banked >= target) streak++;
    else break;
  }

  streakEl.textContent = streak > 1 ? `${streak} day streak` : '';
}

function formatDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
}

// ─── Celebration ──────────────────────────────────────
function showCelebration(count) {
  const el = document.getElementById('celebration');
  document.getElementById('celebration-number').textContent = count;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2200);
  el.addEventListener('click', () => el.classList.add('hidden'), { once: true });
}

// ─── Settings ─────────────────────────────────────────
function openSettings() {
  document.getElementById('target-input').value = currentUser.daily_target;
  document.getElementById('modal-user-name').textContent = currentUser.name;
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const raw    = document.getElementById('target-input').value;
  const target = parseInt(raw, 10);
  if (!target || target < 1 || target > 9999) return;

  try {
    await API.updateSettings(currentUser.name, target);
    currentUser.daily_target = target;
    updateProgressUI();
    renderHistory();
    closeSettings();
  } catch (err) {
    console.error(err);
  }
}

// ─── Load / Switch User ───────────────────────────────
async function loadUser(name) {
  try {
    const data = await API.getUser(name);
    currentUser = data.user;
    todayBanked = data.today.banked;
    todayDate   = data.today.date;
    history     = data.history;

    localStorage.setItem('pushup_name', name);

    document.getElementById('name-screen').classList.remove('active');
    document.getElementById('leaderboard-screen').classList.remove('active');
    document.getElementById('main-screen').classList.add('active');

    updateProgressUI();
    renderHistory();
    updatePendingUI();
    resetWheel();
  } catch (err) {
    console.error(err);
  }
}

async function loadUserSilently(name) {
  try {
    const data = await API.getUser(name);
    currentUser = data.user;
    todayBanked = data.today.banked;
    todayDate   = data.today.date;
    history     = data.history;
    // Stay on leaderboard — data is ready if they click track
  } catch (err) {
    console.error(err);
  }
}

function resetWheel() {
  wheelAngle    = 0;
  totalAngle    = 0;
  pendingReps   = 0;
  wheelEl.style.transform = 'rotate(0deg)';
  updatePendingUI();
}

function showNameScreen() {
  document.getElementById('main-screen').classList.remove('active');
  document.getElementById('name-screen').classList.add('active');
  document.getElementById('name-input').value = '';
  document.getElementById('name-input').focus();
}

// ─── Leaderboard ──────────────────────────────────────
let leaderboardReturnScreen = 'main-screen';

function showLeaderboard(returnTo = 'main-screen') {
  leaderboardReturnScreen = returnTo;
  document.getElementById('name-screen').classList.remove('active');
  document.getElementById('main-screen').classList.remove('active');
  document.getElementById('leaderboard-screen').classList.add('active');
  loadLeaderboard();
}

function hideLeaderboard() {
  document.getElementById('leaderboard-screen').classList.remove('active');
  // If returning from within the app use the stored screen, otherwise
  // go to main if we have a user, or name entry if we don't.
  const dest = leaderboardReturnScreen !== 'leaderboard-screen'
    ? leaderboardReturnScreen
    : currentUser ? 'main-screen' : 'name-screen';
  document.getElementById(dest).classList.add('active');
}

const CONTRIBUTION_COLOURS = [
  '#bb8e8a', // peach
  '#888958', // gumtree
  '#c6cad3', // lavender
  '#782b51', // burgundy
  '#544d62', // smokey pink
  '#a7a7a9', // silver
];

async function loadLeaderboard() {
  const list = document.getElementById('lb-list');
  list.innerHTML = '<div class="lb-empty">loading...</div>';

  try {
    const data = await fetch('/api/leaderboard').then(r => r.json());
    // pg returns numeric aggregates as strings — coerce to numbers
    const rows = data.rows.map(r => ({
      ...r,
      total:       Number(r.total),
      days_active: Number(r.days_active),
      best_day:    Number(r.best_day),
      today:       Number(r.today),
    }));
    renderGroupGoal(rows, data.goal);
    renderLeaderboard(rows, data.goal);
  } catch {
    list.innerHTML = '<div class="lb-empty">failed to load</div>';
  }
}

function renderGroupGoal(rows, goal) {
  const groupTotal = rows.reduce((s, r) => s + r.total, 0);
  const pct        = Math.min((groupTotal / goal.target) * 100, 100);
  const remaining  = Math.max(goal.target - groupTotal, 0);
  const complete   = groupTotal >= goal.target;

  document.getElementById('gg-reward').textContent  = goal.reward;
  document.getElementById('gg-total').textContent   = groupTotal.toLocaleString();
  document.getElementById('gg-target').textContent  = goal.target.toLocaleString();
  document.getElementById('gg-pct').textContent     = Math.floor(pct) + '%';
  document.getElementById('gg-remaining').textContent = remaining > 0
    ? `${remaining.toLocaleString()} to go`
    : 'goal reached';

  const fill = document.getElementById('gg-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('complete', complete);

  // Stacked bar
  const stack = document.getElementById('gg-stack');
  stack.innerHTML = '';
  rows.forEach((row, i) => {
    const segPct = groupTotal > 0 ? (row.total / goal.target) * 100 : 0;
    const colour = CONTRIBUTION_COLOURS[i % CONTRIBUTION_COLOURS.length];
    const seg    = document.createElement('div');
    seg.className = 'gg-segment';
    seg.style.width      = segPct + '%';
    seg.style.background = colour;
    seg.title            = `${row.name}: ${row.total.toLocaleString()}`;
    // Only show label if segment is wide enough
    seg.innerHTML = `<span class="gg-segment-label">${escapeHtml(row.name)}</span>`;
    stack.appendChild(seg);
  });
}

function renderLeaderboard(rows, goal) {
  const list = document.getElementById('lb-list');
  list.innerHTML = '';

  if (!rows.length) {
    list.innerHTML = '<div class="lb-empty">no data yet</div>';
    return;
  }

  const maxTotal   = rows[0].total;
  const groupTotal = rows.reduce((s, r) => s + r.total, 0);

  rows.forEach((row, i) => {
    const rank    = i + 1;
    const barPct  = maxTotal > 0 ? (row.total / maxTotal) * 100 : 0;
    const contPct = groupTotal > 0 ? Math.round((row.total / groupTotal) * 100) : 0;
    const colour  = CONTRIBUTION_COLOURS[i % CONTRIBUTION_COLOURS.length];

    const el = document.createElement('div');
    el.className = 'lb-row';
    el.innerHTML = `
      <div class="lb-rank ${rank <= 3 ? 'top' : ''}">${rank}</div>
      <div class="lb-name-col">
        <div class="lb-name">${escapeHtml(row.name)}</div>
        <div class="lb-meta">
          <span class="lb-meta-item">${row.days_active} day${row.days_active !== 1 ? 's' : ''}</span>
          <span class="lb-meta-item">best <span>${row.best_day}</span></span>
          ${row.today > 0 ? `<span class="lb-meta-item">today <span>${row.today}</span></span>` : ''}
          <span class="lb-meta-item">share <span>${contPct}%</span></span>
        </div>
        <div class="lb-bar-wrap"><div class="lb-bar" style="width:${barPct}%;background:${colour}"></div></div>
      </div>
      <div class="lb-total-col">
        <div class="lb-total">${row.total.toLocaleString()}</div>
        <div class="lb-total-label">total</div>
      </div>
    `;
    list.appendChild(el);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  wheelEl         = document.getElementById('wheel');
  marksGroup      = document.getElementById('wheel-marks');
  wheelCenterText = document.getElementById('wheel-center-text');

  buildWheelMarks();

  // Wheel events — mouse
  wheelEl.addEventListener('mousedown',  onPointerDown);
  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('mouseup',   onPointerUp);

  // Wheel events — touch
  wheelEl.addEventListener('touchstart', onPointerDown, { passive: false });
  document.addEventListener('touchmove', onPointerMove, { passive: false });
  document.addEventListener('touchend',  onPointerUp);

  // Bank
  document.getElementById('bank-btn').addEventListener('click', bankReps);

  // Name form
  document.getElementById('name-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('name-input').value.trim();
    if (name) loadUser(name);
  });

  // Change name
  document.getElementById('change-name-btn').addEventListener('click', showNameScreen);

  // Leaderboard
  document.getElementById('leaderboard-btn').addEventListener('click', () => showLeaderboard('main-screen'));
  document.getElementById('name-leaderboard-btn').addEventListener('click', () => showLeaderboard('name-screen'));
  document.getElementById('leaderboard-back-btn').addEventListener('click', hideLeaderboard);
  document.getElementById('leaderboard-refresh-btn').addEventListener('click', loadLeaderboard);

  // Settings
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-save').addEventListener('click', saveSettings);
  document.querySelector('.modal-backdrop').addEventListener('click', closeSettings);
  document.getElementById('target-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveSettings();
  });

  // Always start on leaderboard; silently prep user data if name is saved
  loadLeaderboard();
  const saved = localStorage.getItem('pushup_name');
  if (saved) loadUserSilently(saved);
});
