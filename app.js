// Fill these in from Supabase: Project Settings > API Keys.
// Use the public publishable (anon) key ONLY. Never put a secret/service_role key here.
const SUPABASE_URL = 'https://mplwdvogydzdxwiqcutk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1I5iUEWXaTbjKMGRH8f60w_TLGK5IIK';
const ELECTION_TITLE = 'Association Board Election';
const OTP_LENGTH = 8; // must match Supabase: Authentication > Providers > Email > OTP length

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app');

let pendingEmail = '';
let positions = [];
let selected = {}; // { positionId: candidateId }
let isAdmin = false;

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

function setWelcome(title, text) {
  document.getElementById('welcome-title').textContent = title;
  document.getElementById('welcome-text').textContent = text;
}

function setNav(active) {
  document.querySelectorAll('[data-nav]').forEach((b) =>
    b.classList.toggle('active', b.dataset.nav === active));
}

function steps(n) {
  const labels = ['Sign in', 'Verify', 'Vote', 'Review'];
  return `<div class="steps">${labels.map((s, i) => `
    <div class="step ${i + 1 === n ? 'current' : i + 1 < n ? 'done' : ''}">
      <div class="bubble">${i + 1 < n ? '&#10003;' : i + 1}</div>${s}
    </div>${i < 3 ? '<div class="connector"></div>' : ''}`).join('')}</div>`;
}

function maskEmail(v) {
  const [a, b] = v.split('@');
  return (a.length > 2 ? a.slice(0, 2) + '•••' : a[0] + '••') + '@' + b;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

// Disable a button while an async action runs; surface errors as toasts.
async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    if (button) button.disabled = false;
  }
}

function message(kind, title, text) {
  app.innerHTML = `<div class="center">
    <h2>${escapeHtml(title)}</h2>
    <div class="notice ${kind}">${escapeHtml(text)}</div></div>`;
}

// --- Screens: sign in -------------------------------------------------------

function renderEmail() {
  setNav('portal');
  setWelcome('Your voice. Your association.',
    'A simple, guided way for eligible ADOHRE members to take part in association elections. Sign in to begin.');
  app.innerHTML = `
    <h2>Welcome to ADOHRE</h2>
    <p class="sub">Sign in using the email address registered with the association.</p>
    ${steps(1)}
    <form id="form-email">
      <label class="field" for="email">Email address</label>
      <input id="email" class="input" type="email" autocomplete="email" placeholder="e.g. juan@example.com" required>
      <div class="notice">&#128274; A verification code will be sent to this email. Your identity is verified before the ballot becomes available.</div>
      <button class="btn full" type="submit">Send verification code &nbsp;&rarr;</button>
    </form>
    <div class="hint" style="text-align:center;margin-top:18px">Need help? Contact the ADOHRE election administrator.</div>`;
  if (pendingEmail) document.getElementById('email').value = pendingEmail;

  document.getElementById('form-email').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      pendingEmail = document.getElementById('email').value.trim().toLowerCase();
      await sendCode();
      renderOtp();
    });
  };
}

async function sendCode() {
  const { error } = await db.auth.signInWithOtp({
    email: pendingEmail,
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
}

function renderOtp() {
  setWelcome('Secure member verification',
    'One more step before you vote. A one-time code was sent to your registered email address.');
  app.innerHTML = `
    <h2>Verify your email</h2>
    <p class="sub">Enter the ${OTP_LENGTH}-digit verification code sent to <b>${escapeHtml(maskEmail(pendingEmail))}</b>. Check your spam folder if it does not arrive.</p>
    ${steps(2)}
    <form id="form-otp">
      <label class="field">${OTP_LENGTH}-digit verification code</label>
      <div class="otp">${Array.from({ length: OTP_LENGTH }, (_, i) =>
        `<input class="input otpbox" inputmode="numeric" maxlength="1" autocomplete="${i ? 'off' : 'one-time-code'}" aria-label="Digit ${i + 1}" required>`).join('')}</div>
      <div class="hint">Didn't receive the code? <button type="button" id="resend" class="linkbtn">Resend code</button></div>
      <div class="btnrow">
        <button type="button" class="btn outline" id="back">&larr; Back</button>
        <button class="btn" type="submit">Verify and continue &rarr;</button>
      </div>
    </form>`;

  const boxes = [...document.querySelectorAll('.otpbox')];
  boxes[0].focus();
  boxes.forEach((b, i) => {
    b.oninput = () => {
      b.value = b.value.replace(/\D/g, '').slice(-1);
      if (b.value && boxes[i + 1]) boxes[i + 1].focus();
    };
    b.onkeydown = (e) => {
      if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus();
    };
    b.onpaste = (e) => {
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, OTP_LENGTH);
      if (!digits) return;
      e.preventDefault();
      boxes.forEach((x, j) => { x.value = digits[j] || ''; });
      boxes[Math.min(digits.length, OTP_LENGTH - 1)].focus();
    };
  });

  document.getElementById('back').onclick = renderEmail;
  document.getElementById('resend').onclick = (e) =>
    busy(e.currentTarget, async () => {
      await sendCode();
      toast('A new code was sent.');
    });
  document.getElementById('form-otp').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const { error } = await db.auth.verifyOtp({
        email: pendingEmail,
        token: boxes.map((b) => b.value).join(''),
        type: 'email',
      });
      if (error) throw error;
      await route();
    });
  };
}

// --- Screens: voting --------------------------------------------------------

function renderBallot() {
  setWelcome('Make your vote count',
    'Choose one candidate for each position. You can review and change your selections before submitting.');
  app.innerHTML = `
    <h2>Official voting ballot</h2>
    <p class="sub">${escapeHtml(ELECTION_TITLE)}</p>
    ${steps(3)}
    <div class="notice">Please select one candidate for each position.</div>
    ${positions.map((p) => `
      <div class="sectiontitle"><h3>${escapeHtml(p.title)}</h3><span>Select one candidate</span></div>
      <div class="candidate-list">${p.candidates.map((c) => `
        <label class="candidate ${selected[p.id] === c.id ? 'selected' : ''}">
          <div class="avatar">${escapeHtml(initials(c.name))}</div>
          <div style="flex:1"><strong>${escapeHtml(c.name)}</strong></div>
          <input class="radio" type="radio" name="pos-${p.id}" value="${c.id}" data-pos="${p.id}" ${selected[p.id] === c.id ? 'checked' : ''}>
        </label>`).join('')}
      </div>`).join('')}
    <div class="btnrow">
      <button class="btn outline" id="cancel">&larr; Sign out</button>
      <button class="btn" id="review">Review selections &rarr;</button>
    </div>`;

  app.querySelectorAll('input[type=radio]').forEach((r) => {
    r.onchange = () => {
      selected[r.dataset.pos] = Number(r.value);
      renderBallot();
    };
  });
  document.getElementById('cancel').onclick = signOut;
  document.getElementById('review').onclick = () => {
    if (positions.some((p) => !selected[p.id])) {
      toast('Please choose a candidate for each position.');
      return;
    }
    renderReview();
  };
}

function renderReview() {
  setWelcome('Review before you submit',
    'Please carefully check your selections. A submitted vote cannot be changed.');
  const nameOf = (p) => p.candidates.find((c) => c.id === selected[p.id]).name;
  app.innerHTML = `
    <h2>Review your vote</h2>
    <p class="sub">Check your selections before final submission.</p>
    ${steps(4)}
    <div class="notice warn">&#9888;&#65039; <b>Important:</b> Submitting your vote is final. You can go back to edit your choices.</div>
    <div class="sectiontitle"><h3>Your selections</h3><span>${positions.length} position${positions.length === 1 ? '' : 's'}</span></div>
    ${positions.map((p) => `<div class="summaryrow"><span>${escapeHtml(p.title)}</span><strong>${escapeHtml(nameOf(p))}</strong></div>`).join('')}
    <div class="btnrow">
      <button class="btn outline" id="edit">&larr; Edit ballot</button>
      <button class="btn" id="submit">Confirm and submit vote &#10003;</button>
    </div>`;
  document.getElementById('edit').onclick = renderBallot;
  document.getElementById('submit').onclick = (e) =>
    busy(e.currentTarget, async () => {
      await rpc('cast_vote', { choices: selected });
      selected = {};
      renderDone();
    });
}

function renderDone() {
  setWelcome('Thank you for participating', 'Your vote has been recorded.');
  app.innerHTML = `<div class="center">
    <div class="successmark">&#10003;</div>
    <h2>Thank you for voting!</h2>
    <p class="sub">Your vote has been recorded anonymously. You can now sign out.</p>
    <div class="notice success">&#10003; Your ballot cannot be linked back to you.</div>
    <div class="btnrow" style="justify-content:center"><button class="btn" id="done-out">Sign out</button></div>
  </div>`;
  document.getElementById('done-out').onclick = signOut;
}

// --- Screens: guide ---------------------------------------------------------

function renderGuide() {
  setNav('guide');
  setWelcome('A clear guide to online voting',
    'Designed to keep the process simple, even for members less familiar with online services.');
  const items = [
    ['01', 'Sign in', 'Enter the email address registered with the association.'],
    ['02', 'Verify identity', 'Enter the one-time code sent to your email.'],
    ['03', 'Choose candidates', 'Select one candidate for each available position.'],
    ['04', 'Review and submit', 'Check every selection before final submission.'],
  ];
  app.innerHTML = `
    <h2>How voting works</h2>
    <p class="sub">Four straightforward steps to complete a vote.</p>
    ${items.map(([n, t, d]) => `
      <div class="summaryrow" style="justify-content:flex-start;align-items:center">
        <div class="avatar" style="border-radius:10px;width:42px;height:42px">${n}</div>
        <div><strong style="text-align:left">${t}</strong><div class="hint">${d}</div></div>
      </div>`).join('')}
    <div class="notice">Your vote is anonymous. The system records that you have voted, but not what you voted for.</div>
    <div class="btnrow"><button class="btn" id="to-portal">Go to voting portal &rarr;</button></div>`;
  document.getElementById('to-portal').onclick = route;
}

// --- Screens: admin ---------------------------------------------------------

async function loadAdmin() {
  setNav('admin');
  setWelcome('Election results', 'Live turnout and tallies. Visible to administrators only.');
  const [turnout, results] = await Promise.all([rpc('get_turnout'), rpc('get_results')]);
  const pct = turnout.total ? Math.round((turnout.voted / turnout.total) * 100) : 0;
  app.innerHTML = `
    <h2>Turnout &amp; results</h2>
    <p class="sub">Voting is currently <b>${turnout.is_open ? 'open' : 'closed'}</b>.</p>
    <div class="statgrid">
      <div class="stat"><small>Registered voters</small><strong>${turnout.total}</strong></div>
      <div class="stat"><small>Votes cast</small><strong>${turnout.voted}</strong></div>
      <div class="stat"><small>Turnout</small><strong>${pct}%</strong></div>
    </div>
    ${results.map((p) => {
      const total = p.candidates.reduce((n, c) => n + c.votes, 0);
      return `<div class="sectiontitle"><h3>${escapeHtml(p.title)}</h3><span>${total} vote${total === 1 ? '' : 's'}</span></div>
        ${p.candidates.map((c) => `
          <div class="summaryrow" style="display:block">
            <div style="display:flex;justify-content:space-between"><strong style="text-align:left">${escapeHtml(c.name)}</strong><strong>${c.votes}</strong></div>
            <div class="bar"><i style="width:${total ? Math.round((c.votes / total) * 100) : 0}%"></i></div>
          </div>`).join('')}`;
    }).join('')}
    <div class="btnrow"><button class="btn outline" id="refresh">Refresh</button></div>`;
  document.getElementById('refresh').onclick = (e) => busy(e.currentTarget, loadAdmin);
}

// --- Routing ----------------------------------------------------------------

function setSession(session) {
  document.getElementById('signout').hidden = !session;
  document.getElementById('session-email').textContent = session ? session.user.email : '';
  if (!session) document.getElementById('nav-admin').hidden = true;
}

async function route() {
  setNav('portal');
  const { data: { session } } = await db.auth.getSession();
  setSession(session);
  if (!session) {
    renderEmail();
    return;
  }

  const status = await rpc('my_status');
  isAdmin = status.is_admin;
  document.getElementById('nav-admin').hidden = !isAdmin;

  if (location.hash === '#admin') {
    if (!isAdmin) {
      message('error', 'Access denied', 'This account is not an administrator.');
      return;
    }
    await loadAdmin();
    return;
  }

  if (!status.is_voter) {
    setWelcome('Not on the voter list', 'This email is not registered for this election.');
    return message('error', 'Not eligible', 'This email is not on the voter list. Contact the election administrator.');
  }
  if (status.has_voted) {
    setWelcome('Thank you for participating', 'Your vote has already been recorded.');
    return message('success', 'Vote recorded', 'Your vote has been recorded. Thank you!');
  }
  if (!status.is_open) {
    setWelcome('Voting is closed', 'This election is no longer accepting votes.');
    return message('warn', 'Voting is closed', 'This election is no longer accepting votes.');
  }

  positions = await rpc('get_ballot');
  selected = {};
  renderBallot();
}

async function signOut() {
  await db.auth.signOut();
  pendingEmail = '';
  selected = {};
  setSession(null);
  renderEmail();
}

document.getElementById('signout').onclick = signOut;
document.querySelectorAll('[data-nav]').forEach((b) => {
  b.onclick = () => busy(null, async () => {
    if (b.dataset.nav === 'guide') return renderGuide();
    if (b.dataset.nav === 'admin') return loadAdmin();
    history.replaceState(null, '', location.pathname); // leave #admin without a hashchange
    await route();
  });
});
window.addEventListener('hashchange', () => busy(null, route));

// Resume an existing session on page load.
busy(null, route);
