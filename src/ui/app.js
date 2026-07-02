/* NSFW Guard — dashboard + onboarding renderer.
   Talks to main only through window.guard (see ui-preload.js). */

const root = document.getElementById('root');
const modalRoot = document.getElementById('modal-root');
const panicBtn = document.getElementById('panic');

let state = null;

const TRIGGERS = [
  'Late at night', 'Boredom', 'Stress or anxiety', 'Loneliness',
  'Social media', 'Right after waking', 'Specific websites',
  'Feeling down', 'Procrastination', 'Alcohol or substances',
];
const BASELINE = [
  'Multiple times a day', 'Daily', 'A few times a week', 'Weekly', 'Occasionally',
];
const DURATION = [
  'Less than 6 months', '6–12 months', '1–3 years', '3–5 years', '5+ years',
];

// ---------- helpers ----------
function fmtStreak(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return { big: d, unit: d === 1 ? 'day' : 'days', small: `${h}h ${m}m` };
  if (h > 0) return { big: h, unit: h === 1 ? 'hour' : 'hours', small: `${m}m` };
  return { big: m, unit: 'min', small: `${s % 60}s` };
}
function fmtBest(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ===================================================================
//  ONBOARDING
// ===================================================================
function renderOnboarding() {
  panicBtn.classList.add('hidden');
  const data = {
    name: '', why: '', triggers: [], baseline: '', strugglingFor: '',
    goalDays: 90, partner: { name: '', email: '' }, password: '', password2: '',
    committed: false,
  };
  let step = 0;
  const STEPS = 7;

  function shell(inner) {
    const dots = Array.from({ length: STEPS }, (_, i) =>
      `<i class="${i <= step ? 'done' : ''}"></i>`).join('');
    root.innerHTML = `
      <div class="onb">
        <div class="onb-card card">
          <div class="onb-progress">${dots}</div>
          <div class="step">${inner}</div>
        </div>
      </div>`;
  }

  function actions(backLabel, nextLabel, nextEnabled = true) {
    return `<div class="onb-actions">
      ${step > 0 ? `<button class="btn btn-ghost" data-back>${backLabel}</button>` : ''}
      <button class="btn btn-primary" data-next ${nextEnabled ? '' : 'disabled'}>${nextLabel}</button>
    </div>`;
  }

  function draw() {
    if (step === 0) {
      shell(`
        <div class="onb-shield">🛡️</div>
        <h1>Welcome — you've taken the first step.</h1>
        <p class="sub">NSFW Guard quietly watches your screen and steps in the moment things slip, so a single urge doesn't undo your progress. Everything stays on this device.</p>
        <label class="field"><span>What should we call you?</span>
          <input class="input" id="f-name" placeholder="Your name or nickname" value="${data.name}" />
        </label>
        ${actions('Back', 'Get started')}`);
      bindNav(() => { data.name = val('#f-name').trim(); });
    }

    else if (step === 1) {
      shell(`
        <h1>What's your <em style="color:var(--accent);font-style:normal">why</em>?</h1>
        <p class="sub">In a hard moment, your own words will mean more than anything we can say. We'll show this back to you when you need it most.</p>
        <label class="field"><span>I want to quit because…</span>
          <textarea class="textarea" id="f-why" placeholder="e.g. I want to be present for the people I love and respect myself again.">${data.why}</textarea>
        </label>
        ${actions('Back', 'Continue')}`);
      bindNav(() => { data.why = val('#f-why').trim(); });
    }

    else if (step === 2) {
      shell(`
        <h1>When are you most vulnerable?</h1>
        <p class="sub">Knowing your triggers is where lasting change starts. Pick all that apply.</p>
        <div class="chips" id="f-trig">
          ${TRIGGERS.map((t) => `<button class="chip ${data.triggers.includes(t) ? 'on' : ''}" data-chip="${t}">${t}</button>`).join('')}
        </div>
        ${actions('Back', 'Continue')}`);
      root.querySelectorAll('[data-chip]').forEach((c) =>
        c.addEventListener('click', () => {
          const t = c.dataset.chip;
          if (data.triggers.includes(t)) data.triggers = data.triggers.filter((x) => x !== t);
          else data.triggers.push(t);
          c.classList.toggle('on');
        }));
      bindNav(() => {});
    }

    else if (step === 3) {
      shell(`
        <h1>Where are you starting from?</h1>
        <p class="sub">No judgment — an honest baseline helps you see how far you climb.</p>
        <label class="field"><span>How often does this happen now?</span>
          <select class="select" id="f-base">
            <option value="">Select…</option>
            ${BASELINE.map((b) => `<option ${data.baseline === b ? 'selected' : ''}>${b}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>How long have you been struggling with it?</span>
          <select class="select" id="f-dur">
            <option value="">Select…</option>
            ${DURATION.map((d) => `<option ${data.strugglingFor === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </label>
        ${actions('Back', 'Continue')}`);
      bindNav(() => { data.baseline = val('#f-base'); data.strugglingFor = val('#f-dur'); });
    }

    else if (step === 4) {
      shell(`
        <h1>Add an accountability partner</h1>
        <p class="sub">Recovery is far more likely to stick when someone has your back. Your partner holds the password — so in a weak moment, you can't simply switch the guard off yourself.</p>
        <label class="field"><span>Partner's name</span>
          <input class="input" id="f-pname" placeholder="Someone you trust" value="${data.partner.name}" />
        </label>
        <label class="field"><span>Partner's email (kept on this device)</span>
          <input class="input" id="f-pmail" placeholder="partner@email.com" value="${data.partner.email}" />
        </label>
        <div class="partner-hand">🤝 Hand the device to your partner for the next step — they'll set the lock password. You won't be able to disable protection without it.</div>
        ${actions('Back', 'Continue')}`);
      bindNav(() => {
        data.partner.name = val('#f-pname').trim();
        data.partner.email = val('#f-pmail').trim();
      });
    }

    else if (step === 5) {
      shell(`
        <h1>Set the lock password</h1>
        <p class="sub"><b>Partner:</b> choose a password the user doesn't know. It's required to pause, change settings, or quit the app.</p>
        <label class="field"><span>Lock password</span>
          <input class="input" type="password" id="f-pw" placeholder="Choose a strong password" value="${data.password}" />
        </label>
        <label class="field"><span>Confirm password</span>
          <input class="input" type="password" id="f-pw2" placeholder="Re-enter password" value="${data.password2}" />
        </label>
        <div class="err" id="pw-err"></div>
        ${actions('Back', 'Continue')}`);
      bindNav(() => {
        data.password = val('#f-pw'); data.password2 = val('#f-pw2');
      }, () => {
        if (data.password.length < 4) { setErr('#pw-err', 'Use at least 4 characters.'); return false; }
        if (data.password !== data.password2) { setErr('#pw-err', 'Passwords don\'t match.'); return false; }
        return true;
      });
    }

    else if (step === 6) {
      shell(`
        <div class="onb-shield">🎯</div>
        <h1>Make your commitment</h1>
        <p class="sub">Set a goal to climb toward. Most people start with 90 days — the time it takes to rewire the habit.</p>
        <label class="field"><span>Goal streak (days)</span>
          <input class="input" type="number" id="f-goal" min="1" max="3650" value="${data.goalDays}" />
        </label>
        <label class="commit">
          <input type="checkbox" id="f-commit" ${data.committed ? 'checked' : ''} />
          <span>I'm committing to this for myself. When it gets hard, I'll lean on my reasons and my partner instead of giving in.</span>
        </label>
        <div class="err" id="commit-err"></div>
        ${actions('Back', 'Begin')}`);
      bindNav(() => {
        data.goalDays = parseInt(val('#f-goal'), 10) || 90;
        data.committed = root.querySelector('#f-commit').checked;
      }, async () => {
        if (!root.querySelector('#f-commit').checked) {
          setErr('#commit-err', 'Please confirm your commitment to continue.'); return false;
        }
        await finish();
        return false; // finish() handles navigation
      });
    }
  }

  function bindNav(collect, validate) {
    const back = root.querySelector('[data-back]');
    const next = root.querySelector('[data-next]');
    if (back) back.addEventListener('click', () => { collect && collect(); step--; draw(); });
    if (next) next.addEventListener('click', async () => {
      collect && collect();
      if (validate) { const ok = await validate(); if (ok === false) return; }
      step++; draw();
    });
  }

  async function finish() {
    await window.guard.completeOnboarding({
      profile: {
        name: data.name, why: data.why, triggers: data.triggers,
        baseline: data.baseline, strugglingFor: data.strugglingFor,
        goalDays: data.goalDays, partner: data.partner, unlockMode: 'partner',
      },
      password: data.password,
    });
    state = await window.guard.getState();
    renderDashboard();
  }

  draw();
}

// ===================================================================
//  DASHBOARD
// ===================================================================
function renderDashboard() {
  panicBtn.classList.remove('hidden');
  const s = state;
  const st = s.stats;
  const streak = fmtStreak(st.currentStreakMs || 0);
  const statusPill = {
    active: ['active', 'Protected'],
    paused: ['paused', 'Paused'],
    cooling: ['cooling', 'Disabling…'],
  }[s.status] || ['active', 'Protected'];

  root.innerHTML = `
    <div class="dash">
      <div class="topbar">
        <div class="brand">
          <div class="mark">🛡️</div>
          <div><b>NSFW Guard</b><small>100% on-device · nothing leaves your computer</small></div>
        </div>
        <div class="topbar-right">
          <span class="pill ${statusPill[0]}"><span class="dot"></span>${statusPill[1]}</span>
          <button class="icon-btn" id="btn-settings" title="Settings">⚙</button>
          <button class="icon-btn" id="btn-quit" title="Quit">⏻</button>
        </div>
      </div>

      <div class="hero card">
        <div class="label">Current clean streak</div>
        <div class="streak-time">${streak.big}<span>${streak.unit}</span></div>
        <div class="since">${streak.small} · longest so far: ${fmtBest(st.longestStreakMs || 0)}</div>
        <div class="hero-meta">
          <div><b>${st.daysProtected || 0}</b><small>days protected</small></div>
          <div><b>${Math.min(100, Math.round(((st.currentStreakMs/86400000)/(s.profile.goalDays||90))*100))}%</b><small>to ${s.profile.goalDays||90}-day goal</small></div>
          <div><b>${s.status === 'active' ? 'On' : 'Off'}</b><small>real-time guard</small></div>
        </div>
      </div>

      <div class="grid3">
        <div class="stat card"><div class="v accent">${st.totalBlocks || 0}</div><div class="k">Total blocks</div></div>
        <div class="stat card"><div class="v">${st.blocksThisWeek || 0}</div><div class="k">Blocked this week</div></div>
        <div class="stat card"><div class="v">${(s.incidents[0]) ? timeAgo(s.incidents[0].t) : '—'}</div><div class="k">Last incident</div></div>
      </div>

      <div class="grid2">
        <div class="panel card">
          <h3>Your why</h3>
          <div class="why-quote">${s.profile.why ? escapeHtml(s.profile.why) : 'Stay focused on what matters to you.'}</div>
          ${s.profile.partner?.name ? `<div class="note">Accountability partner: <b style="color:var(--text)">${escapeHtml(s.profile.partner.name)}</b></div>` : ''}
        </div>
        <div class="panel card">
          <h3>Recent activity <button class="btn btn-ghost" id="btn-export" style="float:right;padding:5px 11px;font-size:12px">Export</button></h3>
          <div class="log" id="log">${renderLog(s.incidents)}</div>
        </div>
      </div>
    </div>`;

  root.querySelector('#btn-settings').addEventListener('click', openSettings);
  root.querySelector('#btn-quit').addEventListener('click', openQuit);
  root.querySelector('#btn-export').addEventListener('click', () => window.guard.exportLog());
}

function renderLog(incidents) {
  if (!incidents || !incidents.length)
    return `<div class="empty">No incidents yet.<br/>Keep it up — every clean hour rewires the habit.</div>`;
  return incidents.map((i) => `
    <div class="log-row">
      <span class="log-cat">${i.category || 'nsfw'}</span>
      <span class="log-time">${timeAgo(i.t)}</span>
      <span class="log-conf">${i.score}% confident</span>
    </div>`).join('');
}

// ===================================================================
//  MODALS
// ===================================================================
function modal(html) {
  modalRoot.innerHTML = `<div class="overlay-back"><div class="modal card">${html}</div></div>`;
  modalRoot.querySelector('.overlay-back').addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('overlay-back')) closeModal();
  });
}
function closeModal() { modalRoot.innerHTML = ''; }

function openSettings() {
  const set = state.settings;
  modal(`
    <h2>Settings</h2>
    <p>Changing protection settings requires the lock password.</p>
    <label class="field"><span>Sensitivity</span>
      <select class="select" id="s-sexy">
        <option value="false" ${!set.flagSexy ? 'selected' : ''}>Balanced (fewer false alarms)</option>
        <option value="true" ${set.flagSexy ? 'selected' : ''}>Strict (catches suggestive content too)</option>
      </select>
    </label>
    <label class="field"><span>Cooldown before protection can be disabled (seconds)</span>
      <input class="input" type="number" id="s-cool" min="0" max="3600" value="${Math.round((set.disableCooldownMs||0)/1000)}" />
    </label>
    <label class="field"><span>Lock password</span>
      <input class="input" type="password" id="s-pw" placeholder="Required to save" />
    </label>
    <div class="err" id="s-err"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Save</button>
    </div>`);
  modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modalRoot.querySelector('[data-save]').addEventListener('click', async () => {
    const pw = val('#s-pw');
    const patch = {
      flagSexy: val('#s-sexy') === 'true',
      disableCooldownMs: (parseInt(val('#s-cool'), 10) || 0) * 1000,
    };
    const r = await window.guard.updateSettings(pw, patch);
    if (!r.ok) { setErr('#s-err', 'Incorrect password.'); return; }
    closeModal();
  });
}

function openDisable() {
  modal(`
    <h2>Pause protection?</h2>
    <p>This turns off real-time blocking. Your accountability partner's password is required.</p>
    <label class="field"><span>Lock password</span>
      <input class="input" type="password" id="d-pw" placeholder="Partner's password" autofocus />
    </label>
    <div class="err" id="d-err"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>Never mind</button>
      <button class="btn btn-danger" data-go>Begin pause</button>
    </div>`);
  modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modalRoot.querySelector('[data-go]').addEventListener('click', async () => {
    const r = await window.guard.requestDisable(val('#d-pw'));
    if (!r.ok) { setErr('#d-err', 'Incorrect password.'); return; }
    showCooldown();
  });
}

function showCooldown() {
  const tick = () => {
    const remain = Math.ceil((state.cooldownRemainingMs || 0) / 1000);
    if (state.status !== 'cooling') {
      // finished -> now paused
      modal(`
        <h2>Protection paused</h2>
        <p>Real-time blocking is off. Turn it back on whenever you're ready — future-you is rooting for you.</p>
        <div class="modal-actions"><button class="btn btn-primary" data-resume>Resume protection</button></div>`);
      modalRoot.querySelector('[data-resume]').addEventListener('click', async () => {
        await window.guard.resume(); closeModal();
      });
      return;
    }
    modal(`
      <h2>Hold on…</h2>
      <div class="cooldown-num">${remain}</div>
      <div class="cooldown-sub">A short pause before protection turns off.<br/>This is the moment to reconsider. The urge will fade.</div>
      <div class="modal-actions"><button class="btn btn-primary" data-stay>Stay strong — cancel</button></div>`);
    modalRoot.querySelector('[data-stay]').addEventListener('click', async () => {
      await window.guard.cancelDisable(); closeModal();
    });
  };
  tick();
  // re-render handled by onUpdate; but ensure first paint
}

function openQuit() {
  modal(`
    <h2>Quit NSFW Guard?</h2>
    <p>Quitting ends real-time protection completely. The lock password is required.</p>
    <label class="field"><span>Lock password</span>
      <input class="input" type="password" id="q-pw" placeholder="Partner's password" autofocus />
    </label>
    <div class="err" id="q-err"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-cancel>Stay protected</button>
      <button class="btn btn-danger" data-go>Quit anyway</button>
    </div>`);
  modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modalRoot.querySelector('[data-go]').addEventListener('click', async () => {
    const r = await window.guard.requestQuit(val('#q-pw'));
    if (!r.ok) setErr('#q-err', 'Incorrect password.');
  });
}

function openBreathing() {
  modal(`
    <div class="breathe-wrap">
      <div class="breathe-circle">Breathe</div>
      <div>
        <h2 style="margin-bottom:6px">This will pass</h2>
        <p style="margin:0">Breathe with the circle. In through your nose, hold, slowly out.<br/>Urges peak and fade in minutes — you can ride this one out.</p>
      </div>
      <button class="btn btn-primary" data-done>I'm okay now</button>
    </div>`);
  modalRoot.querySelector('[data-done]').addEventListener('click', closeModal);
}

// ===================================================================
//  small utils + boot
// ===================================================================
function val(sel) { const e = root.querySelector(sel) || modalRoot.querySelector(sel); return e ? e.value : ''; }
function setErr(sel, msg) { const e = (root.querySelector(sel) || modalRoot.querySelector(sel)); if (e) e.textContent = msg; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

panicBtn.addEventListener('click', openBreathing);

// live updates from main
window.guard.onUpdate((next) => {
  state = next;
  // if a modal cooldown is showing, refresh it; otherwise refresh dashboard
  if (modalRoot.querySelector('.cooldown-num') || (state.status !== 'active' && modalRoot.querySelector('.modal'))) {
    if (document.querySelector('.dash')) renderDashboard();
    showCooldown();
  } else if (document.querySelector('.dash')) {
    renderDashboard();
  }
});

window.guard.onRequestQuit(() => openQuit());

// allow dashboard pause via keyboard-free path: clicking status pill opens pause
document.addEventListener('click', (e) => {
  if (e.target.closest('.pill.active')) openDisable();
});

(async function boot() {
  state = await window.guard.getState();
  if (!state.onboarded) renderOnboarding();
  else renderDashboard();
})();
