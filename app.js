// Fill these in from Supabase: Project Settings > API Keys.
// Use the public publishable (anon) key ONLY. Never put a secret/service_role key here.
const SUPABASE_URL = 'https://mplwdvogydzdxwiqcutk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1I5iUEWXaTbjKMGRH8f60w_TLGK5IIK';
const ELECTION_TITLE = 'ADOHRE Election';
const ADMIN_REFRESH_MS = 30000; // admin screens refresh this often
const WATCH_INTERVAL_MS = 15000; // waiting voters check for a newly opened poll this often
const MAX_OPTIONS = 15; // keep in sync with schema.sql
const MAX_POSITIONS = 20; // keep in sync with schema.sql
const MAX_VOTES = 15; // most votes (or answers) one voter can be given; keep in sync with schema.sql
// Address the voters' QR codes point to. Leave empty to use the address this page is opened from
// (when the admin page is opened on the live site, that is already the right address).
const PUBLIC_URL = '';
const SESSION_KEY = 'adohre.session.v1'; // the voter's session token, kept until they sign out

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
try { localStorage.removeItem('adohre.myVotes.v1'); } catch { /* storage blocked */ }
const app = document.getElementById('app');

let pendingEmail = '';
let selected = {}; // { positionId: [optionId, ...] } picked on the current ballot
let isAdmin = false;
let adminEmail = '';
let voterName = '';
let adminDenied = false; // set when an email-code sign-in turned out not to be an administrator
let liveTimer = null;

// --- Helpers ----------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.getElementById('toastroot').append(t);
  setTimeout(() => t.remove(), 3500);
}

// Modal confirmation. Resolves true on confirm, false on cancel / Escape / backdrop click.
function confirmDialog({ title, text, confirmText = 'Confirm', cancelText = 'Cancel', icon = '&#8617;', danger = false }) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-text">
        <div class="modal-icon ${danger ? 'danger' : ''}">${icon}</div>
        <h3 id="modal-title">${escapeHtml(title)}</h3>
        <p id="modal-text">${escapeHtml(text)}</p>
        <div class="modal-actions">
          <button type="button" class="btn outline" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'danger' : ''}" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const btns = [...overlay.querySelectorAll('button')];
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      }
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) close(false);
      const act = e.target.closest('[data-act]');
      if (act) close(act.dataset.act === 'ok');
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    overlay.querySelector('[data-act="cancel"]').focus(); // safe default
  });
}

function setWelcome(title, text) {
  document.getElementById('welcome-title').textContent = title;
  document.getElementById('welcome-text').textContent = text;
}

function setNav(active) {
  document.querySelectorAll('[data-nav]').forEach((b) =>
    b.classList.toggle('active', b.dataset.nav === active));
}

function steps(n) {
  const labels = ['Scan QR', 'Verify', 'Vote', 'Review'];
  return `<div class="steps">${labels.map((s, i) => `
    <div class="step ${i + 1 === n ? 'current' : i + 1 < n ? 'done' : ''}">
      <div class="bubble">${i + 1 < n ? '&#10003;' : i + 1}</div>${s}
    </div>${i < 3 ? '<div class="connector"></div>' : ''}`).join('')}</div>`;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

// --- Voter session ----------------------------------------------------------
// Voters have no email login. A QR code + their registered email/phone starts a session whose token
// is kept in this browser until they sign out (or an admin revokes their access).

class AccessEnded extends Error {}

let memSession = null; // fallback when browser storage is blocked
const getVoterSession = () => {
  try { return localStorage.getItem(SESSION_KEY) || memSession; } catch { return memSession; }
};
const setVoterSession = (token) => {
  memSession = token;
  try { token ? localStorage.setItem(SESSION_KEY, token) : localStorage.removeItem(SESSION_KEY); } catch { /* blocked */ }
};

// Call a voter function with the session token. If the server says the access ended (revoked,
// signed out elsewhere), clear everything and show the "access ended" screen.
async function vrpc(name, args = {}) {
  const session = getVoterSession();
  if (!session) {
    endVoterAccess(false);
    throw new AccessEnded();
  }
  const { data, error } = await db.rpc(name, { p_session: session, ...args });
  if (error) {
    if (/access has ended/i.test(error.message || '')) {
      endVoterAccess(true);
      throw new AccessEnded();
    }
    throw error;
  }
  return data;
}

function endVoterAccess(announce) {
  stopLive();
  setVoterSession(null);
  voterName = '';
  selected = {};
  refreshChrome();
  if (announce) renderAccessEnded(); else renderScan();
}

// Disable a button while an async action runs; surface errors as toasts. If `pending` is given the
// button shows that text meanwhile, so a slow request (sending an email can take 20+ seconds) never
// looks like nothing happened.
async function busy(button, fn, pending) {
  const original = button ? button.innerHTML : '';
  if (button) {
    button.disabled = true;
    if (pending) button.textContent = pending;
  }
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof AccessEnded)) toast(e.message || String(e)); // AccessEnded already showed its own screen
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      if (pending) button.innerHTML = original;
    }
  }
}

function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
}

// --- Screens: administrator sign-in (email + password) ----------------------
// Only admins have passwords (set with supabase/set_admin_password.sql). Voters never sign in here.

function renderEmail() {
  stopLive();
  setNav('portal');
  setWelcome('Administrator access', 'Manage polls and record attendance. Voters do not sign in here: they scan their QR code.');
  app.innerHTML = `
    <h2>Administrator sign-in</h2>
    <p class="sub">Sign in with your administrator email address and password.</p>
    <form id="form-admin">
      <label class="field" for="email">Administrator email address</label>
      <input id="email" class="input" type="email" autocomplete="username" placeholder="e.g. admin@example.com" required>
      <label class="field" for="password">Password</label>
      <input id="password" class="input" type="password" autocomplete="current-password" required>
      <div class="notice">&#128274; Only registered administrators can sign in here.</div>
      <button class="btn full" type="submit">Sign in &nbsp;&rarr;</button>
    </form>
    <div class="hint" style="text-align:center;margin-top:18px">Voting? Go back and scan the QR code from the registration desk.</div>`;
  if (pendingEmail) {
    document.getElementById('email').value = pendingEmail;
    document.getElementById('password').focus();
  }

  document.getElementById('form-admin').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      pendingEmail = document.getElementById('email').value.trim().toLowerCase();
      const { error } = await db.auth.signInWithPassword({
        email: pendingEmail,
        password: document.getElementById('password').value,
      });
      if (error) {
        document.getElementById('password').value = '';
        throw new Error(/invalid login credentials/i.test(error.message) ? 'Wrong email or password.' : error.message);
      }
      await route();
    }, 'Signing in…');
  };
}

// --- Screens: voter entry (QR code, then registered email/phone) ------------

const QR_PROBLEMS = {
  invalid: 'This QR code is not valid. Please see the registration desk.',
  revoked: 'Access for this QR code has ended. Please see the registration desk.',
  locked: 'Too many wrong attempts. Please see the registration desk to unlock your QR code.',
};

function renderScan() {
  stopLive();
  setNav('portal');
  setWelcome('Your voice. Your association.',
    'Record your attendance at the registration desk, then scan your QR code to begin.');
  app.innerHTML = `
    <h2>Welcome to ADOHRE</h2>
    <p class="sub">To vote, first record your attendance at the registration desk. You will be shown a QR code to scan with your phone.</p>
    ${steps(1)}
    <div class="scanbox">
      <div class="scanicon" aria-hidden="true">&#9638;</div>
      <div><b>Scan your QR code</b><span>Use your phone's camera. It opens this page with your voting access.</span></div>
    </div>
    <div class="notice">&#128274; Your attendance must be recorded first. Already scanned? Ask the registration desk to show your code again.</div>
    <div class="hint" style="text-align:center;margin-top:18px">Administrator? <a href="#admin">Sign in here</a></div>`;
}

function renderQrProblem(reason) {
  stopLive();
  setNav('portal');
  setWelcome('QR code problem', 'Your QR code could not be used.');
  app.innerHTML = `<div class="center">
    <h2>We could not open your voting access</h2>
    <div class="notice error">${escapeHtml(QR_PROBLEMS[reason] || QR_PROBLEMS.invalid)}</div>
    <p class="sub">The registration desk can show you a new QR code.</p>
  </div>`;
}

function renderAccessEnded() {
  setNav('portal');
  setWelcome('Access ended', 'Your voting access is no longer active on this device.');
  app.innerHTML = `<div class="center">
    <h2>Your access has ended</h2>
    <div class="notice warn">An administrator ended your voting access, or you were signed out. Please see the registration desk if you still need to vote.</div>
    <div class="btnrow" style="justify-content:center"><button class="btn" id="ended-ok">OK</button></div>
  </div>`;
  document.getElementById('ended-ok').onclick = renderScan;
}

// The QR link carries only a secret token. The voter must also type the email or number registered
// for the member the QR was issued to; the server checks that match.
function renderVerify(token, notice) {
  stopLive();
  setNav('portal');
  setWelcome('Verify your identity', 'One more step before you vote.');
  app.innerHTML = `
    <h2>Verify your identity</h2>
    <p class="sub">Enter your registered cellphone number or email address to proceed.</p>
    ${steps(2)}
    ${notice ? `<div class="notice error">${escapeHtml(notice)}</div>` : ''}
    <form id="form-verify" autocomplete="off">
      <label class="field" for="identifier">Cellphone number or email address</label>
      <input id="identifier" class="input" autocomplete="off" autocapitalize="none" spellcheck="false"
        placeholder="e.g. 0917 123 4567 or juan@example.com" required>
      <div class="notice">&#128274; It must match the details registered for the QR code you scanned.</div>
      <button class="btn full" type="submit">Continue &nbsp;&rarr;</button>
    </form>`;
  document.getElementById('identifier').focus();
  document.getElementById('form-verify').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const { data, error } = await db.rpc('voter_redeem', {
        p_token: token,
        p_identifier: document.getElementById('identifier').value,
      });
      if (error) throw error;
      if (!data.ok) {
        if (data.reason === 'mismatch') {
          renderVerify(token, 'That does not match the details registered for this QR code. Please check and try again.');
        } else {
          renderQrProblem(data.reason);
        }
        return;
      }
      setVoterSession(data.session);
      voterName = data.name;
      history.replaceState(null, '', location.pathname + location.hash); // drop the QR token from the address bar
      await route();
 }, 'Checking…');
  };
}

// --- Screens: voting --------------------------------------------------------

// The signature changes whenever a poll opens, closes, or the voter votes in one.
const pollSignature = (polls) => polls.map((p) => `${p.id}:${p.has_voted ? 1 : 0}`).join(',');

// While a voter sits on the Active polls page, pick up polls the admin opens or closes.
function startWatch(shownSignature) {
  stopLive();
  liveTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const polls = await vrpc('get_active_polls');
      if (pollSignature(polls) === shownSignature) return;
      const known = new Set(shownSignature.split(',').filter(Boolean).map((x) => x.split(':')[0]));
      if (polls.some((p) => !p.has_voted && !known.has(String(p.id)))) toast('A new poll is now open.');
      await renderActivePolls(polls);
    } catch { /* keep trying */ }
  }, WATCH_INTERVAL_MS);
}

function renderWaiting() {
  setWelcome('Active polls', 'Polls appear here when the administrator opens them. This page updates by itself.');
  app.innerHTML = `<div class="center">
    <div class="waitmark"><i></i><i></i><i></i></div>
    <h2>No poll is open right now</h2>
    <p class="sub">Please wait. A poll will appear here as soon as the administrator starts it.</p>
    <div class="btnrow" style="justify-content:center"><button class="btn outline" id="check">Refresh</button></div>
  </div>`;
  document.getElementById('check').onclick = (e) => busy(e.currentTarget, () => renderActivePolls());
  startWatch('');
}

// Voter home: every Active poll, the ones still to vote in first.
async function renderActivePolls(prefetched) {
  stopLive();
  setNav('portal');
  const polls = prefetched || await vrpc('get_active_polls');
  if (!polls.length) return renderWaiting();

  const sorted = [...polls].sort((x, y) => Number(x.has_voted) - Number(y.has_voted) || x.id - y.id);
  const todo = sorted.filter((p) => !p.has_voted).length;
  setWelcome('Active polls', 'Choose a poll to vote in. Several polls can be open at the same time.');
  app.innerHTML = `
    <h2>Active polls</h2>
    <p class="sub">${todo
      ? `You have ${todo} poll${todo === 1 ? '' : 's'} left to vote in. Select one to open its ballot.`
      : 'You have voted in every Active poll. Thank you!'}</p>
    <div class="history-list">${sorted.map((p) => `
      <button type="button" class="history-item ${p.has_voted ? 'voted' : ''}" data-poll="${p.id}" ${p.has_voted ? 'disabled aria-label="' + escapeHtml(p.title) + ' (already voted)"' : ''}>
        <span style="min-width:0">
          <strong>${escapeHtml(p.title)}</strong>
          <span class="hint">${pollSummary(p)}</span>
        </span>
        <span class="chip ${p.has_voted ? 'open' : 'lead'}">${p.has_voted ? 'Voted' : 'Vote now'}</span>
        <span class="chev" aria-hidden="true">&rsaquo;</span>
      </button>`).join('')}</div>
    <div class="btnrow"><button class="btn outline" id="refresh-polls">Refresh</button></div>`;

  document.getElementById('refresh-polls').onclick = (e) =>
    busy(e.currentTarget, async () => {
      await renderActivePolls();
      toast('Active polls refreshed.');
    });
  app.querySelectorAll('[data-poll]:not([disabled])').forEach((btn) => {
    btn.onclick = () => {
      selected = {};
      renderBallot(sorted.find((p) => String(p.id) === btn.dataset.poll));
    };
  });
  startWatch(pollSignature(polls));
}

const pickedCount = () => Object.values(selected).reduce((n, ids) => n + ids.length, 0);

function positionHint(pos) {
  return pos.max_votes === 1 ? 'Select one' : `Select up to ${pos.max_votes}`;
}

function ballotHint(poll) {
  if (poll.kind === 'question') {
    const max = poll.positions[0].max_votes;
    return max === 1
      ? 'Choose one answer.'
      : `Select between 1 and ${max} answers. You do not have to use all ${max}.`;
  }
  return 'Choose your candidates for each position. You may leave a position blank, but select at least one candidate overall.';
}

function positionBlock(pos, isQuestion) {
  const multi = pos.max_votes > 1;
  return `
    <section class="position" data-position="${pos.id}">
      ${isQuestion && !multi ? '' : `<div class="position-head">
        ${isQuestion ? '' : `<div class="sectiontitle"><h3>${escapeHtml(pos.title)}</h3><span>${positionHint(pos)}</span></div>`}
        ${multi ? `<div class="counter" data-counter="${pos.id}"></div>` : ''}
      </div>`}
      <div class="candidate-list">${pos.options.map((o) => `
        <label class="candidate ${isQuestion ? 'answer' : ''}">
          ${isQuestion ? '' : `<div class="avatar">${escapeHtml(initials(o.label))}</div>`}
          <div style="flex:1"><strong>${escapeHtml(o.label)}</strong></div>
          <input class="radio" type="${multi ? 'checkbox' : 'radio'}" name="pos-${pos.id}" value="${o.id}" data-pos="${pos.id}">
        </label>`).join('')}
      </div>
      ${!isQuestion && !multi ? `<button type="button" class="linkbtn" data-clear="${pos.id}" hidden>Clear selection</button>` : ''}
    </section>`;
}

function renderBallot(poll) {
  stopLive();
  const isQuestion = poll.kind === 'question';
  // Keep only selections that still exist (the poll may have been edited or reopened).
  const valid = {};
  poll.positions.forEach((pos) => {
    const ids = (selected[pos.id] || []).filter((id) => pos.options.some((o) => o.id === id));
    if (ids.length) valid[pos.id] = ids;
  });
  selected = valid;

  setWelcome(isQuestion ? 'Your answer matters' : 'Make your vote count',
    isQuestion
      ? (poll.positions[0].max_votes > 1 ? 'Choose your answers. You can review them before submitting.' : 'Choose your answer. You can review it before submitting.')
      : 'Choose your candidates for each position. You can review your selections before submitting.');
  app.innerHTML = `
    <h2>${escapeHtml(poll.title)}</h2>
    <p class="sub">${escapeHtml(poll.description || ELECTION_TITLE)}</p>
    ${steps(3)}
    <div class="notice">${escapeHtml(ballotHint(poll))}</div>
    ${poll.positions.map((pos) => positionBlock(pos, isQuestion)).join('')}
    <div class="btnrow">
      <button class="btn outline" id="cancel">&larr; Active polls</button>
      <button class="btn" id="review">Review selections &rarr;</button>
    </div>`;

  const sync = () => {
    poll.positions.forEach((pos) => {
      const ids = selected[pos.id] || [];
      const multi = pos.max_votes > 1;
      app.querySelectorAll(`input[data-pos="${pos.id}"]`).forEach((inp) => {
        const checked = ids.includes(Number(inp.value));
        inp.checked = checked;
        // At the limit, lock the unchecked ones so a voter cannot exceed this position's maximum.
        inp.disabled = multi && !checked && ids.length >= pos.max_votes;
        const label = inp.closest('.candidate');
        label.classList.toggle('selected', checked);
        label.classList.toggle('disabled', inp.disabled);
      });
      const counter = app.querySelector(`[data-counter="${pos.id}"]`);
      if (counter) counter.textContent = `${ids.length} of ${pos.max_votes} selected`;
      const clear = app.querySelector(`[data-clear="${pos.id}"]`);
      if (clear) clear.hidden = ids.length === 0;
    });
  };

  poll.positions.forEach((pos) => {
    const multi = pos.max_votes > 1;
    app.querySelectorAll(`input[data-pos="${pos.id}"]`).forEach((inp) => {
      inp.onchange = () => {
        const id = Number(inp.value);
        const cur = selected[pos.id] || [];
        selected[pos.id] = multi ? (inp.checked ? [...cur, id] : cur.filter((x) => x !== id)) : [id];
        sync();
      };
    });
  });
  app.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.onclick = () => { delete selected[btn.dataset.clear]; sync(); };
  });
  sync();

  document.getElementById('cancel').onclick = async () => {
    if (pickedCount() > 0) {
      const leave = await confirmDialog({
        title: 'Leave this ballot?',
        text: 'Your selections have not been submitted and will be lost.',
        confirmText: 'Leave', cancelText: 'Stay',
      });
      if (!leave) return;
    }
    selected = {};
    await busy(null, () => renderActivePolls());
  };
  document.getElementById('review').onclick = () => {
    if (!pickedCount()) {
      toast(isQuestion ? 'Please choose an answer.' : 'Please select at least one candidate.');
      return;
    }
    renderReview(poll);
  };
}

function renderReview(poll) {
  const isQuestion = poll.kind === 'question';
  setWelcome('Review before you submit',
    'Please carefully check your selections. A submitted vote cannot be changed.');
  const rows = poll.positions.map((pos) => {
    const picked = pos.options.filter((o) => (selected[pos.id] || []).includes(o.id));
    const label = (i) => isQuestion ? (pos.max_votes > 1 ? `Answer ${i + 1}` : 'Answer') : `Candidate ${i + 1}`;
    return `${isQuestion ? '' : `<div class="sectiontitle"><h3>${escapeHtml(pos.title)}</h3><span>${picked.length} of up to ${pos.max_votes}</span></div>`}
      ${picked.length
        ? picked.map((o, i) => `<div class="summaryrow"><span>${label(i)}</span><strong>${escapeHtml(o.label)}</strong></div>`).join('')
        : `<div class="summaryrow"><span>No selection</span><strong class="skipped">Skipped</strong></div>`}`;
  }).join('');
  app.innerHTML = `
    <h2>Review your vote</h2>
    <p class="sub">${escapeHtml(poll.title)}</p>
    ${steps(4)}
    <div class="notice warn">&#9888;&#65039; <b>Important:</b> Submitting your vote is final. You can go back to edit your choices.</div>
    ${rows}
    <div class="btnrow">
      <button class="btn outline" id="edit">&larr; Edit ballot</button>
      <button class="btn" id="submit">Confirm and submit vote &#10003;</button>
    </div>`;
  document.getElementById('edit').onclick = () => renderBallot(poll);
  document.getElementById('submit').onclick = (e) =>
    busy(e.currentTarget, async () => {
      const sure = await confirmDialog({
        title: 'Submit your vote?',
        text: `Your vote on "${poll.title}" is final. It cannot be changed or withdrawn after you submit.`,
        confirmText: 'Submit vote', cancelText: 'Go back', icon: '&#10003;',
      });
      if (!sure) return;
      const ids = poll.positions.flatMap((pos) => selected[pos.id] || []);
      try {
        await vrpc('cast_vote', { p_poll_id: poll.id, p_option_ids: ids });
      } catch (err) {
        // The poll was ended, or the vote already counted: resync with the server.
        if (/not open|already voted/i.test(err.message || '')) {
          toast(err.message);
          selected = {};
          await route();
          return;
        }
        throw err;
      }
      selected = {};
      renderDone(poll);
    });
}

function renderDone(poll) {
  setWelcome('Thank you for participating', 'Your vote has been recorded.');
  app.innerHTML = `<div class="center">
    <div class="successmark">&#10003;</div>
    <h2>Thank you for voting!</h2>
    <p class="sub">Your vote on <b>${escapeHtml(poll.title)}</b> has been recorded anonymously.</p>
    <div class="notice success">&#10003; Your ballot cannot be linked back to you.</div>
    <div class="notice">Other polls may be open. Go back to Active polls to vote in them.</div>
    <div class="btnrow" style="justify-content:center">
      <button class="btn" id="done-polls">Active polls</button>
      <button class="btn outline" id="done-out">Sign out</button>
    </div>
  </div>`;
  document.getElementById('done-polls').onclick = (e) => busy(e.currentTarget, () => renderActivePolls());
  document.getElementById('done-out').onclick = requestSignOut;
}

// --- Screens: guide ---------------------------------------------------------

function renderGuide() {
  stopLive();
  setNav('guide');
  setWelcome('A clear guide to online voting',
    'Designed to keep the process simple, even for members less familiar with online services.');
  const items = [
    ['01', 'Verify identity', 'Enter your registered number or email address to proceed.'],
    ['02', 'Choose your vote', 'Select your vote on each item on the ballot. Take your time, as you can change your choices before you submit.'],
    ['03', 'Review and submit', 'Check every selection before final submission.'],
  ];
  app.innerHTML = `
    <h2>How voting works</h2>
    <p class="sub">Three straightforward steps to complete a vote.</p>
    ${items.map(([n, t, d]) => `
      <div class="summaryrow" style="justify-content:flex-start;align-items:center">
        <div class="avatar" style="border-radius:10px;width:42px;height:42px">${n}</div>
        <div><strong style="text-align:left">${t}</strong><div class="hint">${d}</div></div>
      </div>`).join('')}
    <div class="notice">First record your attendance at the registration desk and scan your QR code. Several polls may be open at the same time: choose the one you want from Active polls, and new polls appear there automatically. Your vote is anonymous: the system records that you have voted, but not what you voted for.</div>
    <div class="btnrow"><button class="btn" id="to-portal">Go to voting portal &rarr;</button></div>`;
  document.getElementById('to-portal').onclick = route;
}

// --- Screens: admin ---------------------------------------------------------

// DB statuses: draft / open / closed / cancelled.
const STATUS_LABEL = { draft: 'Not Active', open: 'Active', closed: 'Closed', cancelled: 'Cancelled' };

// Every status change asks first. One definition shared by the poll list and the dashboard.
function statusPlan(act, p, present) {
  return {
    start: { title: 'Activate this poll?', text: `"${p.title}" will become Active and open right away to everyone who is present (${present} voter${present === 1 ? '' : 's'} at the moment).`, confirmText: 'Activate', icon: '&#9654;', status: 'open', done: 'Poll is now Active.' },
    reopen: { title: 'Reopen this poll?', text: `"${p.title}" will become Active again. Voters who already voted cannot vote twice.`, confirmText: 'Reopen', icon: '&#8635;', status: 'open', done: 'Poll reopened. It is now Active.' },
    end: { title: 'Close this poll?', text: `Voters will no longer be able to submit votes for "${p.title}". You can reopen it later.`, confirmText: 'Close poll', icon: '&#9632;', danger: true, status: 'closed', done: 'Poll closed.' },
    cancel: { title: 'Cancel this poll?', text: `"${p.title}" will be voided and hidden from voters. A cancelled poll cannot be reopened or changed.`, confirmText: 'Cancel poll', cancelText: 'Keep poll', icon: '&#10006;', danger: true, status: 'cancelled', done: 'Poll cancelled.' },
  }[act];
}

function pollSummary(p) {
  if (p.kind === 'question') {
    const pos = p.positions[0];
    return `Question &middot; ${escapeHtml(pos.options.map((o) => o.label).join(' / '))}${pos.max_votes > 1 ? ` &middot; up to ${pos.max_votes} answers` : ''}`;
  }
  const perPosition = p.positions.map((x) =>
    `${escapeHtml(x.title)} (${x.options.length} candidate${x.options.length === 1 ? '' : 's'})`);
  return `Election &middot; ${perPosition.join(', ')}`;
}

// Actions that live in the kebab menu, per status. Risky ones go below a separator.
function pollMenuItems(p) {
  const item = (act, label, danger) =>
    `<button type="button" role="menuitem" class="${danger ? 'danger-item' : ''}" data-act="${act}" data-id="${p.id}">${label}</button>`;
  let safe = [];
  let risky = [];
  if (p.status === 'draft') {
    safe = [item('start', 'Activate'), item('edit', 'Edit')];
    risky = [item('cancel', 'Cancel poll', true), item('delete', 'Delete', true)];
  } else if (p.status === 'open') {
    safe = [item('end', 'Close poll')];
    risky = [item('cancel', 'Cancel poll', true)];
  } else if (p.status === 'closed') {
    safe = [item('reopen', 'Reopen')];
    risky = [item('cancel', 'Cancel poll', true), item('reset', 'Clear votes', true), item('delete', 'Delete', true)];
  } else { // cancelled
    risky = [item('reset', 'Clear votes', true), item('delete', 'Delete', true)];
  }
  return safe.join('') + (safe.length && risky.length ? '<div class="menu-sep" role="separator"></div>' : '') + risky.join('');
}

// Kebab menu on the dashboard: the status change for this poll, then Cancel poll.
function dashMenuItems(d) {
  const item = (act, label, danger) =>
    `<button type="button" role="menuitem" class="${danger ? 'danger-item' : ''}" data-act="${act}">${label}</button>`;
  const main = { draft: item('start', 'Activate'), open: item('end', 'Close poll'), closed: item('reopen', 'Reopen') }[d.status] || '';
  return main + (main ? '<div class="menu-sep" role="separator"></div>' : '') + item('cancel', 'Cancel poll', true);
}

// The one button kept on the card: opening the dashboard.
function pollPrimary(p) {
  const label = { open: 'Live dashboard', closed: 'View results', cancelled: 'View votes' }[p.status];
  return label
    ? `<button type="button" class="btn outline small" data-act="dashboard" data-id="${p.id}">${label}</button>`
    : '';
}

function closeMenus(refocus = false) {
  document.querySelectorAll('.poll-side .menu:not([hidden])').forEach((m) => {
    m.hidden = true;
    const kebab = m.parentElement.querySelector('.kebab');
    kebab.setAttribute('aria-expanded', 'false');
    if (refocus) kebab.focus();
  });
}

function toggleMenu(kebab) {
  const menu = kebab.parentElement.querySelector('.menu');
  const wasClosed = menu.hidden;
  closeMenus();
  if (wasClosed) {
    menu.hidden = false;
    kebab.setAttribute('aria-expanded', 'true');
    // Inside a scrolling list the menu would be clipped: place it against the viewport instead.
    const scrolling = kebab.closest('.att-scroll');
    if (scrolling) {
      const r = kebab.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.right = `${document.documentElement.clientWidth - r.right}px`;
      const below = r.bottom + 6;
      menu.style.top = `${below + menu.offsetHeight > innerHeight ? Math.max(8, r.top - 6 - menu.offsetHeight) : below}px`;
    }
    menu.querySelector('button')?.focus({ preventScroll: !!scrolling });
  }
}

// A viewport-placed menu would drift away from its kebab when anything scrolls: close it.
document.addEventListener('scroll', () => {
  if (document.querySelector('.menu[style*="fixed"]:not([hidden])')) closeMenus();
}, true);

function onMenuKey(e) {
  const menu = e.target.closest('.menu');
  if (!menu) return;
  const items = [...menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Tab') closeMenus();
}

function paintPolls(data) {
  const { present, polls } = data;
  document.getElementById('poll-list').innerHTML = polls.length
    ? polls.map((p) => `
      <article class="poll-card ${p.status}">
        <div class="poll-top">
          <div style="min-width:0">
            <h3>${escapeHtml(p.title)}</h3>
            <div class="hint">${pollSummary(p)}</div>
          </div>
          <div class="poll-side">
            <span class="chip ${p.status}">${STATUS_LABEL[p.status]}</span>
            <button type="button" class="kebab" data-kebab aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${escapeHtml(p.title)}">&#8942;</button>
            <div class="menu" role="menu" hidden>${pollMenuItems(p)}</div>
          </div>
        </div>
        ${p.status === 'draft' || p.status === 'cancelled' && !p.voted ? '' : `
        <div class="progress small"><i style="width:${present ? Math.min(100, Math.round((p.voted / present) * 100)) : 0}%"></i></div>
        <div class="hint">${p.voted} of ${present} present voter${present === 1 ? '' : 's'} ha${p.voted === 1 && present !== 1 ? 's' : 've'} voted</div>`}
        ${pollPrimary(p) ? `<div class="poll-actions">${pollPrimary(p)}</div>` : ''}
      </article>`).join('')
    : `<div class="notice">No polls yet. Click <b>New poll</b> to create one.</div>`;
  polls.forEach((p) => { pollCache[p.id] = p; });
  pollTotal = present;
}

let pollCache = {};
let pollTotal = 0;

async function loadPolls() {
  stopLive();
  setNav('admin');
  setWelcome('Manage polls', 'Create polls, activate, close, reopen or cancel them, and view results. Visible to administrators only.');
  app.innerHTML = `
    <div class="dash-head">
      <h2>Polls</h2>
      <button class="btn" id="new-poll">+ New poll</button>
    </div>
    <p class="sub">Several polls can be Active at the same time. Voters see every Active poll and choose which to vote in.</p>
    <div id="poll-list"></div>`;
  document.getElementById('new-poll').onclick = () => renderPollEditor();
  document.getElementById('poll-list').onclick = onPollAction;
  document.getElementById('poll-list').onkeydown = onMenuKey;

  const refresh = async () => paintPolls(await rpc('admin_list_polls'));
  await refresh().catch((e) => toast(e.message || String(e)));
  liveTimer = setInterval(() => {
    // Do not repaint while a menu is open: it would close under the admin's cursor.
    if (!document.hidden && !document.querySelector('.poll-side .menu:not([hidden])')) refresh().catch(() => {});
  }, ADMIN_REFRESH_MS);
}

async function changeStatus(p, status) {
  await rpc('admin_set_poll_status', { p_id: p.id, p_status: status });
}

async function onPollAction(e) {
  const kebab = e.target.closest('[data-kebab]');
  if (kebab) return toggleMenu(kebab);
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  closeMenus();
  const p = pollCache[Number(btn.dataset.id)];
  if (!p) return;
  const act = btn.dataset.act;

  if (act === 'edit') return renderPollEditor(p);
  if (act === 'dashboard') return loadDashboard(p.id);

  const status = statusPlan(act, p, pollTotal);
  const plans = {
    reset: { title: 'Clear all votes?', text: `This deletes every vote in "${p.title}" and lets everyone vote in it again. Use it for testing only. It cannot be undone.`, confirmText: 'Clear votes', icon: '&#9888;', danger: true, run: () => rpc('admin_reset_poll', { p_id: p.id }), done: 'Votes cleared.' },
    delete: { title: 'Delete this poll?', text: `"${p.title}" and all of its votes will be permanently deleted.`, confirmText: 'Delete poll', icon: '&#128465;', danger: true, run: () => rpc('admin_delete_poll', { p_id: p.id }), done: 'Poll deleted.' },
  };
  const plan = status ? { ...status, run: () => changeStatus(p, status.status) } : plans[act];
  if (!plan || !(await confirmDialog(plan))) return;
  await busy(btn, async () => {
    await plan.run();
    toast(plan.done);
    paintPolls(await rpc('admin_list_polls'));
  });
}

function renderPollEditor(poll) {
  stopLive();
  setNav('admin');
  const editing = !!poll;
  setWelcome(editing ? 'Edit poll' : 'New poll', 'Create a question or an election. You can activate it when you are ready.');
  const kind = poll ? poll.kind : 'question';
  const qpos = poll && poll.kind === 'question' ? poll.positions[0] : null;
  const multiSel = !!qpos && qpos.max_votes > 1;
  const optionText = qpos ? qpos.options.map((o) => o.label).join('\n') : 'Yes\nNo\nAbstain';
  const startPositions = poll && poll.kind === 'candidates'
    ? poll.positions.map((x) => ({ title: x.title, max_votes: x.max_votes, options: x.options.map((o) => o.label) }))
    : [{ title: '', max_votes: 1, options: [] }];

  app.innerHTML = `
    <h2>${editing ? 'Edit poll' : 'New poll'}</h2>
    <p class="sub">Saved as Not Active. Nothing is visible to voters until you activate it.</p>
    <form id="form-poll">
      <label class="field" for="p-title" id="title-label">Title</label>
      <input id="p-title" class="input" maxlength="200" required value="${escapeHtml(poll ? poll.title : '')}">

      <label class="field" for="p-desc">Description <span class="opt">(optional)</span></label>
      <input id="p-desc" class="input" maxlength="1000" placeholder="Shown to voters under the title" value="${escapeHtml(poll && poll.description || '')}">

      <label class="field">Type</label>
      <div class="typegrid">
        <label class="typecard"><input type="radio" name="kind" value="question" ${kind === 'question' ? 'checked' : ''}>
          <b>Question</b><small>Such as Yes / No / Abstain, with one or several answers.</small></label>
        <label class="typecard"><input type="radio" name="kind" value="candidates" ${kind === 'candidates' ? 'checked' : ''}>
          <b>Election</b><small>Positions such as President, Vice President and Directors, each with its own candidates.</small></label>
      </div>

      <div id="q-wrap">
        <label class="field">Selection</label>
        <div class="typegrid">
          <label class="typecard"><input type="radio" name="sel" value="single" ${multiSel ? '' : 'checked'}>
            <b>Only 1 selection</b><small>Voters choose a single answer. This is the default.</small></label>
          <label class="typecard"><input type="radio" name="sel" value="multiple" ${multiSel ? 'checked' : ''}>
            <b>Multiple selections</b><small>Voters may choose more than one answer.</small></label>
        </div>

        <label class="field" for="p-options">Answer choices (one per line)</label>
        <textarea id="p-options" class="input" rows="6" spellcheck="false">${escapeHtml(optionText)}</textarea>
        <div class="hint" id="options-hint"></div>

        <div id="votes-wrap">
          <label class="field" for="p-max">Maximum answers per voter</label>
          <input id="p-max" class="input narrow" type="number" min="2" max="${MAX_VOTES}" value="${multiSel ? qpos.max_votes : 2}">
          <div class="hint">Voters must pick at least 1, and up to this many.</div>
        </div>
      </div>

      <div id="e-wrap">
        <div class="sectiontitle"><h3>Positions &amp; candidates</h3>
          <button type="button" class="btn outline small" id="add-position">+ Add position</button></div>
        <p class="hint" style="margin-top:0">Add each position (for example President), list its candidates, and set how many candidates a voter may choose for it. Up to ${MAX_OPTIONS} candidates and ${MAX_VOTES} votes per position.</p>
        <div id="positions"></div>
      </div>

      <label class="check"><input type="checkbox" id="p-live" ${poll && poll.show_live_results ? 'checked' : ''}>
        <span>Show live results to admins while the poll is Active</span></label>
      <div class="hint">Off is safer: live counts can reveal how an individual voted. Results appear when you close the poll.</div>

      <div class="btnrow">
        <button type="button" class="btn outline" id="cancel-poll">&larr; Back to polls</button>
        <button class="btn" type="submit">${editing ? 'Save changes' : 'Create poll'}</button>
      </div>
    </form>`;

  const kindOf = () => app.querySelector('input[name="kind"]:checked').value;
  const selOf = () => app.querySelector('input[name="sel"]:checked').value;
  const linesOf = (el) => el.value.split('\n').map((l) => l.trim()).filter(Boolean);
  const optionsEl = document.getElementById('p-options');
  const container = document.getElementById('positions');
  const blocks = () => [...container.querySelectorAll('.posblock')];

  const blockHtml = (pos) => `
    <div class="posblock">
      <div class="poshead"><b class="posnum"></b>
        <button type="button" class="linkbtn dangerlink" data-remove>Remove</button></div>
      <label class="field">Position title</label>
      <input class="input pos-title" maxlength="200" placeholder="e.g. President, Vice President, Directors" value="${escapeHtml(pos.title)}">
      <label class="field">Candidates (one per line)</label>
      <textarea class="input pos-options" rows="5" spellcheck="false">${escapeHtml(pos.options.join('\n'))}</textarea>
      <div class="hint pos-hint"></div>
      <label class="field">Votes per voter for this position (maximum)</label>
      <input class="input narrow pos-max" type="number" min="1" max="${MAX_VOTES}" value="${pos.max_votes}">
    </div>`;

  const updateHint = (block) => {
    const n = linesOf(block.querySelector('.pos-options')).length;
    const hint = block.querySelector('.pos-hint');
    hint.textContent = `${n} of ${MAX_OPTIONS} candidates`;
    hint.classList.toggle('over', n > MAX_OPTIONS);
  };
  const renumber = () => {
    blocks().forEach((blk, i) => {
      blk.querySelector('.posnum').textContent = `Position ${i + 1}`;
      blk.querySelector('[data-remove]').hidden = blocks().length === 1;
      updateHint(blk);
    });
    document.getElementById('add-position').disabled = blocks().length >= MAX_POSITIONS;
  };
  startPositions.forEach((pos) => container.insertAdjacentHTML('beforeend', blockHtml(pos)));
  renumber();

  const addPositionBtn = document.getElementById('add-position');
  addPositionBtn.onclick = async () => {
    const ok = await confirmDialog({
      title: 'Add a position?',
      text: 'A new empty position will be added to this election. Fill in its title and candidates before saving.',
      confirmText: 'Add position', icon: '+',
    });
    if (!ok) return;
    container.insertAdjacentHTML('beforeend', blockHtml({ title: '', max_votes: 1, options: [] }));
    renumber();
    blocks().at(-1).querySelector('.pos-title').focus();
  };
  container.onclick = async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (!rm || blocks().length < 2) return;
    const blk = rm.closest('.posblock');
    const name = blk.querySelector('.pos-title').value.trim() || blk.querySelector('.posnum').textContent;
    const n = linesOf(blk.querySelector('.pos-options')).length;
    const ok = await confirmDialog({
      title: `Remove "${name}"?`,
      text: `This position${n ? ` and its ${n} candidate${n === 1 ? '' : 's'}` : ''} will be removed from the form. Nothing is saved until you click ${editing ? 'Save changes' : 'Create poll'}.`,
      confirmText: 'Remove position', icon: '&#128465;', danger: true,
    });
    if (!ok) return;
    blk.remove();
    renumber();
  };
  container.oninput = (e) => {
    const blk = e.target.closest('.posblock');
    if (blk) updateHint(blk);
  };

  const refresh = () => {
    const isQ = kindOf() === 'question';
    document.getElementById('q-wrap').hidden = !isQ;
    document.getElementById('e-wrap').hidden = isQ;
    document.getElementById('votes-wrap').hidden = !isQ || selOf() !== 'multiple';
    document.getElementById('title-label').textContent = isQ ? 'Title' : 'Election title';
    document.getElementById('p-title').placeholder = isQ ? 'e.g. Ratification of the By-Laws' : 'e.g. Board of Directors Election 2026';
    document.getElementById('options-hint').textContent = `${linesOf(optionsEl).length} of ${MAX_OPTIONS} choices (minimum 2)`;
    document.getElementById('options-hint').classList.toggle('over', linesOf(optionsEl).length > MAX_OPTIONS);
  };
  app.querySelectorAll('input[name="kind"]').forEach((r) => { r.onchange = refresh; });
  app.querySelectorAll('input[name="sel"]').forEach((r) => { r.onchange = refresh; });
  optionsEl.oninput = refresh;
  refresh();

  // Snapshot of everything the admin can change, to tell whether leaving would lose work.
  const snapshot = () => JSON.stringify([
    document.getElementById('p-title').value, document.getElementById('p-desc').value, kindOf(), selOf(),
    optionsEl.value, document.getElementById('p-max').value, document.getElementById('p-live').checked,
    blocks().map((b) => [b.querySelector('.pos-title').value, b.querySelector('.pos-options').value, b.querySelector('.pos-max').value]),
  ]);
  const initial = snapshot();

  // Throws an Error describing the first problem with one set of options.
  const checkOptions = (who, opts, max, minOpts, noun) => {
    if (opts.length < minOpts) throw new Error(minOpts > 1 ? `${who} needs at least ${minOpts} ${noun}.` : `${who} needs at least 1 candidate.`);
    if (opts.length > MAX_OPTIONS) throw new Error(`${who} can have at most ${MAX_OPTIONS} ${noun}.`);
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) throw new Error(`${who}: names must be unique.`);
    if (!Number.isInteger(max) || max < 1 || max > MAX_VOTES) throw new Error(`${who}: votes per voter must be between 1 and ${MAX_VOTES}.`);
    if (max > opts.length) throw new Error(`${who}: votes per voter (${max}) cannot exceed the number of ${noun} (${opts.length}).`);
  };

  document.getElementById('cancel-poll').onclick = async () => {
    if (snapshot() !== initial) {
      const ok = await confirmDialog({
        title: 'Discard your changes?',
        text: editing ? 'Your edits to this poll have not been saved and will be lost.' : 'This poll has not been created yet. What you entered will be lost.',
        confirmText: 'Discard', cancelText: 'Keep editing', icon: '&#9888;', danger: true,
      });
      if (!ok) return;
    }
    await loadPolls();
  };
  document.getElementById('form-poll').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const k = kindOf();
      let positions;
      if (k === 'question') {
        const opts = linesOf(optionsEl);
        const max = selOf() === 'multiple' ? Number(document.getElementById('p-max').value) : 1;
        if (selOf() === 'multiple' && max < 2) throw new Error('Multiple selections needs a maximum of at least 2.');
        checkOptions('This question', opts, max, 2, 'choices');
        positions = [{ max_votes: max, options: opts }];
      } else {
        positions = blocks().map((blk, i) => ({
          title: blk.querySelector('.pos-title').value.trim(),
          max_votes: Number(blk.querySelector('.pos-max').value),
          options: linesOf(blk.querySelector('.pos-options')),
          n: i + 1,
        }));
        positions.forEach((pos) => {
          if (!pos.title) throw new Error(`Position ${pos.n} needs a title.`);
          checkOptions(`"${pos.title}"`, pos.options, pos.max_votes, 1, 'candidates');
        });
        if (new Set(positions.map((x) => x.title.toLowerCase())).size !== positions.length) {
          throw new Error('Position titles must be unique.');
        }
        positions = positions.map(({ title, max_votes, options }) => ({ title, max_votes, options }));
      }
      const title = document.getElementById('p-title').value.trim();
      const ok = await confirmDialog({
        title: editing ? 'Save changes?' : 'Create this poll?',
        text: editing
          ? `Changes to "${title}" will replace its current details.`
          : `"${title}" will be created as Not Active. Voters will not see it until you activate it.`,
        confirmText: editing ? 'Save changes' : 'Create poll',
        icon: '&#10003;',
      });
      if (!ok) return;
      await rpc('admin_save_poll', { p: {
        id: poll ? poll.id : null,
        title,
        description: document.getElementById('p-desc').value,
        kind: k,
        show_live_results: document.getElementById('p-live').checked,
        positions,
      } });
      toast('Poll saved.');
      await loadPolls();
    });
  };
}

// --- Screens: poll dashboard ------------------------------------------------

function paintDashboard(d) {
  const presentLeft = Math.max(d.present - d.voted, 0);
  const pct = d.present ? Math.min(100, Math.round((d.voted / d.present) * 100)) : 0;

  document.getElementById('dash-status').innerHTML =
    `<span class="chip ${d.status}">${STATUS_LABEL[d.status]}</span>`;
  document.getElementById('dash-progress').innerHTML = `
    <div class="progress-head"><strong>${pct}%</strong><span>of present voters have voted</span></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="statgrid">
      <div class="stat"><small>Present (attendance)</small><strong>${d.present}</strong></div>
      <div class="stat"><small>Voted</small><strong>${d.voted}</strong></div>
      <div class="stat"><small>Yet to vote</small><strong>${presentLeft}</strong></div>
    </div>`;

  const box = document.getElementById('dash-results');
  if (d.results === null) {
    box.innerHTML = `<div class="notice">&#128274; Results are hidden while the poll is Active, so nobody can work out how an individual voted. They appear here automatically once you close the poll.</div>`;
    return;
  }
  const isQ = d.kind === 'question';
  const ranked = !isQ && d.status === 'closed'; // order by votes once final
  const ballots = d.results.reduce((n, pos) => n + pos.options.reduce((m, o) => m + o.votes, 0), 0);
  const anyMulti = d.results.some((pos) => pos.max_votes > 1);

  box.innerHTML = `
    ${d.status === 'cancelled' ? `<div class="notice error">&#10006; This poll was cancelled and is void. The votes below are kept for reference only.</div>` : ''}
    ${d.status === 'draft' ? `<div class="notice">This poll is Not Active yet. No votes have been cast.</div>` : ''}
    <div class="sectiontitle"><h3>${d.status === 'closed' ? 'Final results' : d.status === 'cancelled' ? 'Votes (void)' : 'Results so far'}</h3>
      <span>${d.voted} voter${d.voted === 1 ? '' : 's'} &middot; ${ballots} vote${ballots === 1 ? '' : 's'} cast</span></div>
    ${d.results.map((pos) => {
      const rows = ranked ? [...pos.options].sort((a, b) => b.votes - a.votes) : pos.options;
      const top = Math.max(0, ...rows.map((r) => r.votes));
      return `
        ${isQ ? '' : `<div class="posres"><h4>${escapeHtml(pos.title)}</h4><span>${pos.max_votes === 1 ? '1 vote each' : `up to ${pos.max_votes} votes each`}</span></div>`}
        ${rows.map((r, i) => {
          const share = d.voted ? Math.round((r.votes / d.voted) * 100) : 0;
          return `<div class="summaryrow" style="display:block">
            <div style="display:flex;justify-content:space-between;gap:12px">
              <strong style="text-align:left">${ranked ? `<span class="rank">${i + 1}</span>` : ''}${escapeHtml(r.label)}${top > 0 && r.votes === top ? ' <span class="chip lead">Leading</span>' : ''}</strong>
              <strong>${r.votes} <span style="color:var(--muted);font-weight:500">(${share}%)</span></strong>
            </div>
            <div class="bar"><i style="width:${share}%"></i></div>
          </div>`;
        }).join('')}`;
    }).join('')}
    <div class="hint">Percentages show the share of all voters who selected each ${isQ ? 'answer' : 'candidate'}${anyMulti ? ', so a position with several votes can add up to more than 100%' : ''}. A voter may leave a position blank.</div>`;
}

async function loadDashboard(id) {
  stopLive();
  setNav('admin');
  setWelcome('Voting dashboard', 'Live voting progress. Visible to administrators only.');
  app.innerHTML = `
    <div class="dash-head">
      <h2 id="dash-title">Voting progress</h2>
      <div class="dash-meta">
        <div id="dash-status"></div>
        <div class="live-badge" id="live-badge"><i></i><span>Loading&hellip;</span></div>
        <div class="poll-side" id="dash-menu-wrap" hidden>
          <button type="button" class="kebab" data-kebab aria-haspopup="menu" aria-expanded="false" aria-label="Poll actions">&#8942;</button>
          <div class="menu" role="menu" id="dash-menu" hidden></div>
        </div>
      </div>
    </div>
    <p class="sub" id="dash-sub">Refreshes every ${ADMIN_REFRESH_MS / 1000} seconds</p>
    <div id="dash-progress"></div>
    <div id="dash-results"></div>
    <div class="btnrow">
      <button class="btn outline" id="back-polls">&larr; All polls</button>
      <button class="btn outline" id="refresh">Refresh</button>
    </div>`;

  let current = null;
  const refresh = async () => {
    const badge = document.getElementById('live-badge');
    if (!badge) return; // navigated away mid-request
    try {
      const d = await rpc('admin_poll_dashboard', { p_id: id });
      if (!document.getElementById('live-badge')) return;
      current = d;
      document.getElementById('dash-title').textContent = d.title;
      document.getElementById('dash-sub').textContent =
        (d.description ? d.description + ' · ' : '') + `refreshes every ${ADMIN_REFRESH_MS / 1000} seconds`;
      paintDashboard(d);
      document.getElementById('dash-menu-wrap').hidden = d.status === 'cancelled'; // nothing can change
      const menu = document.getElementById('dash-menu');
      const items = dashMenuItems(d);
      if (menu.hidden && menu.innerHTML !== items) menu.innerHTML = items; // never rebuild under an open menu
      badge.className = 'live-badge';
      badge.querySelector('span').textContent = 'Live · updated ' + new Date().toLocaleTimeString();
    } catch (e) {
      badge.className = 'live-badge offline';
      badge.querySelector('span').textContent = 'Connection lost, retrying…';
      throw e;
    }
  };

  document.getElementById('back-polls').onclick = loadPolls;
  document.getElementById('refresh').onclick = (e) => busy(e.currentTarget, refresh);
  // Every status change confirms first, using the same plans as the poll list.
  const change = (act) => async (e) => {
    if (!current) return;
    const plan = statusPlan(act, current, current.present);
    if (!(await confirmDialog(plan))) return;
    await busy(e.currentTarget, async () => {
      await changeStatus(current, plan.status);
      toast(plan.done);
      await refresh();
    });
  };
  const wrap = document.getElementById('dash-menu-wrap');
  wrap.onkeydown = onMenuKey;
  wrap.onclick = (e) => {
    const kebab = e.target.closest('[data-kebab]');
    if (kebab) return toggleMenu(kebab);
    const item = e.target.closest('button[data-act]');
    if (!item) return;
    closeMenus();
    return change(item.dataset.act)({ currentTarget: item });
  };

  await refresh().catch((e) => toast(e.message || String(e)));
  liveTimer = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, ADMIN_REFRESH_MS);
}

// --- Screens: attendance (admin) --------------------------------------------

const contactOf = (v) => [v.phone, v.email].filter(Boolean).join(' · ') || 'No contact on file';
const qrLink = (token) => `${PUBLIC_URL || location.origin + location.pathname}?q=${token}`;

function qrSvg(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

// The QR for one member, shown on the admin's screen for the voter to scan.
function showQrDialog(att) {
  const previouslyFocused = document.activeElement;
  const link = qrLink(att.qr_token);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title">
      <h3 id="qr-title">${escapeHtml(att.name || 'Voter')}</h3>
      <div class="qr-box" role="img" aria-label="QR code for ${escapeHtml(att.name || 'this member')}">${qrSvg(link)}</div>
      <p class="qr-help">Ask the voter to scan this with their phone camera. They will then enter their registered email or cellphone number to verify.</p>
      <div class="modal-actions qr-actions">
        <button type="button" class="btn outline" data-qr="copy">Copy link</button>
        <button type="button" class="btn outline" data-qr="print">Print</button>
        <button type="button" class="btn" data-qr="done">Done</button>
      </div>
    </div>`;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  overlay.onclick = async (e) => {
    if (e.target === overlay) return close();
    const act = e.target.closest('[data-qr]')?.dataset.qr;
    if (act === 'done') close();
    if (act === 'print') window.print();
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(link); toast('Link copied.'); }
      catch { toast('Could not copy. Select the link and copy it manually.'); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  overlay.querySelector('[data-qr="done"]').focus();
}

let attendanceCache = [];

function attendanceChip(a) {
  if (a.revoked) return `<span class="chip cancelled">Access revoked</span>`;
  if (a.locked) return `<span class="chip locked">Locked</span>`;
  return `<span class="chip open">Access active</span>`;
}

function attendanceMenu(a) {
  const item = (act, label, danger) =>
    `<button type="button" role="menuitem" class="${danger ? 'danger-item' : ''}" data-act="${act}" data-id="${a.id}">${label}</button>`;
  const first = item('view', 'View details') + item('edit', 'Edit') +
    (a.revoked ? item('restore', 'Restore access') : a.locked ? item('restore', 'Unlock QR code') : '');
  // Someone who already voted cannot be removed (they could be recorded again and vote twice): revoke instead.
  const risky = [a.revoked ? '' : item('revoke', 'Revoke access', true), a.votes ? '' : item('remove', 'Remove attendance', true)].join('');
  return first + (risky ? '<div class="menu-sep" role="separator"></div>' : '') + risky;
}

// Generic dialog with left-aligned content, closed by Escape, backdrop click or any [data-close] button.
function openPanel(html, onAction) {
  const previouslyFocused = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal panel" role="dialog" aria-modal="true" aria-labelledby="panel-title">${html}</div>`;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !overlay.nextElementSibling?.classList.contains('modal-overlay')) { e.preventDefault(); close(); }
  };
  overlay.onclick = (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) return close();
    const act = e.target.closest('[data-panel]');
    if (act && onAction) onAction(act.dataset.panel, overlay, close);
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  (overlay.querySelector('input') || overlay.querySelector('button')).focus();
  return { overlay, close };
}

function showAttendanceDetail(a, onEdit) {
  const row = (k, v) => `<div class="kv"><span>${k}</span><b>${escapeHtml(v || 'Not provided')}</b></div>`;
  const status = a.revoked ? 'Access revoked' : a.locked ? 'Locked' : 'Access active';
  openPanel(`
    <h3 id="panel-title">${escapeHtml(a.name || 'Voter')}</h3>
    <div class="kvs">
      ${row('Email', a.email)}
      ${row('Cellphone', a.phone)}
      ${row('Status', status)}
      ${row('Recorded', new Date(a.recorded_at).toLocaleString())}
      ${row('Recorded by', a.recorded_by)}
      ${row('Signed in on', `${a.sessions} device${a.sessions === 1 ? '' : 's'}`)}
      ${row('Voted in', `${a.votes} poll${a.votes === 1 ? '' : 's'}`)}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn outline" data-close>Close</button>
      <button type="button" class="btn" data-panel="edit">Edit</button>
    </div>`, (act, overlay, close) => {
    if (act === 'edit') { close(); onEdit(a); }
  });
}

function showAttendanceEdit(a, onSaved) {
  const { overlay, close } = openPanel(`
    <h3 id="panel-title">Edit details</h3>
    <form id="att-edit" autocomplete="off" novalidate>
      <label class="field" for="ed-name">Full name</label>
      <input id="ed-name" class="input" autocomplete="off" value="${escapeHtml(a.name || '')}">
      <label class="field" for="ed-email">Email address</label>
      <input id="ed-email" class="input" type="email" autocomplete="off" autocapitalize="none" spellcheck="false" value="${escapeHtml(a.email || '')}">
      <label class="field" for="ed-phone">Cellphone number</label>
      <input id="ed-phone" class="input" type="tel" inputmode="tel" autocomplete="off" value="${escapeHtml(a.phone || '')}">
      <div class="hint">The voter types one of these to sign in, so keep at least one. Their QR code stays the same.</div>
      <div class="notice error" id="ed-error" hidden></div>
      <div class="modal-actions">
        <button type="button" class="btn outline" data-close>Cancel</button>
        <button type="submit" class="btn">Save changes</button>
      </div>
    </form>`);
  const form = overlay.querySelector('#att-edit');
  const err = overlay.querySelector('#ed-error');
  const val = (id) => overlay.querySelector('#' + id).value.trim();
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      err.hidden = true;
      const name = val('ed-name'), email = val('ed-email'), phone = val('ed-phone');
      try {
        if (!name) throw new Error('Enter the full name.');
        if (!email && !phone) throw new Error('Enter an email address or a cellphone number.');
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That email address does not look right.');
        if (phone && phone.replace(/\D/g, '').length < 10) throw new Error('Enter the full cellphone number (at least 10 digits).');
        if (name === (a.name || '') && email === (a.email || '') && phone === (a.phone || '')) return close();
        const ok = await confirmDialog({
          title: 'Save changes?', text: `The details for ${a.name || 'this person'} will be updated.`,
          confirmText: 'Save changes', icon: '&#10003;',
        });
        if (!ok) return;
        const res = await rpc('admin_update_attendance', { p_id: a.id, p_name: name, p_email: email, p_phone: phone });
        if (!res.ok) throw new Error('Already recorded. Email or cellphone number already registered.');
      } catch (ex) {
        err.textContent = ex.message || String(ex);
        err.hidden = false;
        return;
      }
      close();
      toast('Details updated.');
      await onSaved();
    });
  };
}

function paintAttendance(data) {
  attendanceCache = data.attendees;
  document.getElementById('att-count').textContent =
    `${data.present} present` + (data.revoked ? ` · ${data.revoked} revoked` : '');
  const filter = (document.getElementById('att-filter')?.value || '').trim().toLowerCase();
  const rows = data.attendees.filter((a) =>
    !filter || `${a.name || ''} ${a.email || ''} ${a.phone || ''}`.toLowerCase().includes(filter));
  closeMenus();
  document.getElementById('att-list').innerHTML = rows.length
    ? rows.map((a) => `
      <article class="poll-card">
        <div class="poll-top">
          <div style="min-width:0">
            <h3>${escapeHtml(a.name || 'Unnamed')}</h3>
            <div class="hint">Recorded ${escapeHtml(new Date(a.recorded_at).toLocaleString())}${a.sessions ? ` &middot; signed in on ${a.sessions} device${a.sessions === 1 ? '' : 's'}` : ''}${a.votes ? ` &middot; voted in ${a.votes} poll${a.votes === 1 ? '' : 's'}` : ''}</div>
          </div>
          <div class="poll-side">
            ${attendanceChip(a)}
            <button type="button" class="kebab" data-kebab aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${escapeHtml(a.name || 'this member')}">&#8942;</button>
            <div class="menu" role="menu" hidden>${attendanceMenu(a)}</div>
          </div>
        </div>
        <div class="poll-actions"><button type="button" class="btn outline small" data-act="qr" data-id="${a.id}">View QR</button></div>
      </article>`).join('')
    : `<div class="notice">${data.attendees.length ? 'Nobody matches that filter.' : 'No attendance recorded yet.'}</div>`;
}

// The email or cellphone number is already recorded: say only that, without naming anyone.
function paintDuplicate(existing) {
  document.getElementById('att-results').innerHTML = `
    <div class="notice error"><b>Already recorded.</b> Email or cellphone number already registered.</div>
    <div class="btnrow" style="margin-top:0"><button type="button" class="btn outline" data-viewqr="${existing.id}">View QR code</button></div>`;
}

async function loadAttendance() {
  stopLive();
  setNav('attendance');
  setWelcome('Attendance', 'Record who is present and give each voter a QR code to scan. Visible to administrators only.');
  app.innerHTML = `
    <div class="dash-head">
      <h2>Attendance</h2>
      <span class="chip" id="att-count"></span>
    </div>
    <p class="sub">Fill in the form for each person who arrives. Recording their attendance makes them a voter and shows a QR code for them to scan.</p>

    <form id="att-form" class="att-form" autocomplete="off" novalidate>
      <h3>Attendance form</h3>
      <label class="field" for="att-name">Full name</label>
      <input id="att-name" class="input" autocomplete="off" placeholder="e.g. Juan Dela Cruz" required>
      <label class="field" for="att-email">Email address</label>
      <input id="att-email" class="input" type="email" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. juan@example.com">
      <label class="field" for="att-phone">Cellphone number</label>
      <input id="att-phone" class="input" type="tel" inputmode="tel" autocomplete="off" placeholder="e.g. 0917 123 4567">
      <div class="hint">Enter the email address or the cellphone number, or both. The voter types one of them to sign in after scanning, so it must be correct. The only check is that nobody is recorded twice.</div>
      <button class="btn full" type="submit">Record attendance &nbsp;&rarr;</button>
    </form>
    <div id="att-results"></div>

    <div class="sectiontitle"><h3>Attendance list</h3><span>Select View QR to show a code again</span></div>
    <input id="att-filter" class="input" autocomplete="off" placeholder="Filter the list">
    <div id="att-list" class="att-scroll" style="margin-top:12px"></div>`;

  const refresh = async () => paintAttendance(await rpc('admin_list_attendance'));
  const form = document.getElementById('att-form');
  const val = (id) => document.getElementById(id).value;

  document.getElementById('att-filter').oninput = () => paintAttendance({
    attendees: attendanceCache,
    present: attendanceCache.filter((a) => !a.revoked).length,
    revoked: attendanceCache.filter((a) => a.revoked).length,
  });

  const showExisting = async (id) => {
    await refresh();
    const a = attendanceCache.find((x) => x.id === Number(id));
    if (a) showQrDialog(a); else toast('Could not find that attendance record.');
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      document.getElementById('att-results').innerHTML = '';
      const name = val('att-name').trim();
      const email = val('att-email').trim();
      const phone = val('att-phone').trim();
      // Checks the server repeats; done here so staff get a message without a round trip.
      if (!name) throw new Error('Enter the full name.');
      if (!email && !phone) throw new Error('Enter an email address or a cellphone number.');
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That email address does not look right.');
      if (phone && phone.replace(/\D/g, '').length < 10) throw new Error('Enter the full cellphone number (at least 10 digits).');

      const ok = await confirmDialog({
        title: 'Record attendance?',
        text: `${name} (${[phone, email].filter(Boolean).join(' · ')}) will be recorded as present and a QR code will be created for them to scan.`,
        confirmText: 'Record attendance', icon: '&#10003;',
      });
      if (!ok) return;

      const res = await rpc('admin_record_attendance', { p_name: name, p_email: email, p_phone: phone });
      if (!res.ok) {
        paintDuplicate(res.existing);
        return;
      }
      toast('Attendance recorded.');
      form.reset();
      await refresh();
      showQrDialog(res.attendance);
    });
  };

  document.getElementById('att-results').onclick = async (e) => {
    const view = e.target.closest('[data-viewqr]');
    if (view) await busy(view, () => showExisting(view.dataset.viewqr));
  };

  // Actions on the attendance list.
  const list = document.getElementById('att-list');
  list.onkeydown = onMenuKey;
  list.onclick = async (e) => {
    const kebab = e.target.closest('[data-kebab]');
    if (kebab) return toggleMenu(kebab);
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    closeMenus();
    const a = attendanceCache.find((x) => x.id === Number(btn.dataset.id));
    if (!a) return;
    const who = a.name || 'this person';
    const edit = (x) => showAttendanceEdit(x, refresh);
    if (btn.dataset.act === 'view') return showAttendanceDetail(a, edit);
    if (btn.dataset.act === 'edit') return edit(a);
    const plans = {
      revoke: { title: `Revoke access for ${who}?`, text: 'They will be logged out right away on every device and cannot vote until you restore their access.', confirmText: 'Revoke access', icon: '&#9888;', danger: true,
        run: () => rpc('admin_set_attendance_access', { p_id: a.id, p_active: false }), done: 'Access revoked.' },
      restore: { title: `Restore access for ${who}?`, text: 'They will be able to scan and verify again with the same QR code.', confirmText: 'Restore access', icon: '&#8635;',
        run: () => rpc('admin_set_attendance_access', { p_id: a.id, p_active: true }), done: 'Access restored.' },
      remove: { title: `Remove attendance for ${who}?`, text: 'Use this for a mistaken entry. Their QR code stops working and they are logged out. You can record them again afterwards.', confirmText: 'Remove attendance', icon: '&#128465;', danger: true,
        run: () => rpc('admin_remove_attendance', { p_id: a.id }), done: 'Attendance removed.' },
    };
    if (btn.dataset.act === 'qr') return showQrDialog(a);
    const plan = plans[btn.dataset.act];
    if (!plan || !(await confirmDialog(plan))) return;
    await busy(btn, async () => {
      await plan.run();
      toast(plan.done);
      await refresh();
    });
  };

  await refresh().catch((e) => toast(e.message || String(e)));
  liveTimer = setInterval(() => {
    if (!document.hidden && !document.querySelector('.poll-side .menu:not([hidden])')) refresh().catch(() => {});
  }, ADMIN_REFRESH_MS);
}

// --- Routing ----------------------------------------------------------------

const inAdminArea = () => location.hash.startsWith('#admin');

// Sidebar items depend on who is signed in: an administrator (email code) and/or a voter (QR session).
function refreshChrome() {
  const adminView = inAdminArea();
  // The admin portal has its own menu: the voter pages are not part of it.
  document.getElementById('nav-portal').hidden = adminView;
  document.getElementById('nav-guide').hidden = adminView;
  document.getElementById('nav-admin').hidden = !isAdmin;
  document.getElementById('nav-attendance').hidden = !isAdmin;
  document.getElementById('signout').hidden = adminView ? !isAdmin : !getVoterSession();
  document.getElementById('session-email').textContent = adminView ? adminEmail : voterName;
}

// Is a Supabase (email-code) session an administrator? Leftover sessions from the old email-code
// voter login are signed out so they cannot linger.
async function loadAdmin() {
  const { data: { session } } = await db.auth.getSession();
  isAdmin = false;
  adminEmail = '';
  if (!session) return false;
  let admin = false;
  try { admin = (await rpc('my_status')).is_admin; } catch { /* treated as not an admin */ }
  if (!admin) { adminDenied = true; await db.auth.signOut(); return false; }
  isAdmin = true;
  adminEmail = session.user.email;
  return true;
}

async function route() {
  stopLive();
  setNav('portal');
  const admin = await loadAdmin();

  if (inAdminArea()) {
    refreshChrome();
    if (!admin) {
      renderEmail();
      if (adminDenied) { adminDenied = false; toast('That account is not an administrator.'); }
      return;
    }
    if (location.hash === '#admin/attendance') return loadAttendance();
    return loadPolls();
  }

  // Voter area. A QR link carries ?q=<token> and goes to the verification step first.
  const token = new URLSearchParams(location.search).get('q');
  if (token) {
    refreshChrome();
    if (!/^[0-9a-f]{64}$/i.test(token)) return renderQrProblem('invalid');
    return renderVerify(token);
  }

  if (!getVoterSession()) {
    refreshChrome();
    return renderScan();
  }
  const me = await vrpc('voter_me'); // an ended session shows its own screen and stops here
  voterName = me.name;
  refreshChrome();
  selected = {};
  await renderActivePolls();
}

async function requestSignOut() {
  const adminView = inAdminArea();
  const hasChoices = !adminView && pickedCount() > 0;
  const ok = await confirmDialog({
    title: 'Sign out?',
    text: adminView
      ? 'You will need a new verification code to sign in again.'
      : hasChoices
        ? 'You have not submitted your vote yet. Your current selections will be lost.'
        : 'To vote again you will need to scan your QR code and verify.',
    confirmText: 'Sign out',
    cancelText: 'Stay signed in',
  });
  if (ok) await signOut();
}

async function signOut() {
  stopLive();
  if (inAdminArea()) {
    await db.auth.signOut();
    isAdmin = false;
    adminEmail = '';
    pendingEmail = '';
    refreshChrome();
    renderEmail();
    return;
  }
  const session = getVoterSession();
  try { await db.rpc('voter_sign_out', { p_session: session }); } catch { /* the token is cleared below anyway */ }
  setVoterSession(null);
  voterName = '';
  selected = {};
  refreshChrome();
  renderScan();
}

document.addEventListener('click', (e) => { if (!e.target.closest('.poll-side')) closeMenus(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.poll-side .menu:not([hidden])')) closeMenus(true);
});
document.getElementById('signout').onclick = requestSignOut;
document.querySelectorAll('[data-nav]').forEach((b) => {
  b.onclick = () => busy(null, async () => {
    const nav = b.dataset.nav;
    if (nav === 'guide') { renderGuide(); return; }
    const hash = nav === 'admin' ? '#admin' : nav === 'attendance' ? '#admin/attendance' : '';
    history.replaceState(null, '', location.pathname + hash); // also drops any ?q= from the address
    await route();
  });
});
window.addEventListener('hashchange', () => busy(null, route));

// Resume an existing session (or start the QR flow) on page load.
busy(null, route);
