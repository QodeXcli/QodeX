/**
 * Dashboard pieces for secret entry (vault_request_login) and the vault panel.
 * src/control/dashboard.ts merges them in: the strings into DASHBOARD_STRINGS, the
 * CSS after its own, the panels into the side column, and SECRET_DASHBOARD_SCRIPT
 * at the end of its ONE inline script (so the CSP hash still covers everything and
 * the script can use the dashboard's api/t/$/el helpers).
 *
 * Rules the page follows (the server enforces them again, src/control/secret-routes.ts):
 *   - a password is always sealed in the page (ECDH P-256 + HKDF + AES-GCM, the
 *     SECRET_SEAL_JS shared with the tests) when crypto.subtle exists; plaintext is
 *     only ever sent when the server says the connection is 'local';
 *   - over plain-http LAN ('refused') no secret form is shown at all;
 *   - typed values are cleared from the inputs once saved and never put anywhere
 *     else (no storage, no activity feed, no title).
 */

import { SECRET_SEAL_JS } from './secret-crypto.js';

export const SECRET_DASHBOARD_STRINGS: Record<'en' | 'fa', Record<string, string>> = {
  en: {
    secTitle: 'Login requested',
    secEntry: 'Vault entry',
    secRotate: 'replaces the saved password',
    secNote: 'Typed here, it goes straight into the encrypted vault — the agent never sees it.',
    secUser: 'Username or email',
    secPass: 'Password',
    secTotp: '2FA setup key (optional)',
    secSave: 'Save to vault',
    secCancel: 'Cancel',
    secSaved: 'Saved in the vault.',
    secRefused: 'Passwords cannot be typed over plain http on the local network. Open the control center on this computer (localhost) or through its https link.',
    secNoCrypto: 'This browser cannot encrypt the form (no WebCrypto). Use a current browser, or open the control center on this computer.',
    vault: 'Vault',
    vaultEmpty: 'No saved logins yet.',
    vaultAdd: 'Add a login',
    vaultName: 'Name (e.g. github)',
    vaultSites: 'Sites (e.g. github.com)',
    vaultLoginUrl: 'Login page URL (optional)',
    vaultNewPass: 'New password (empty = keep)',
    vaultNewTotp: 'New 2FA setup key (optional)',
    vaultUserKeep: 'Username (empty = keep)',
    vaultRotateBtn: 'Change password',
    vaultEdit: 'Edit',
    vaultDelete: 'Delete',
    vaultConfirmDelete: 'Delete the saved login "{name}"? This cannot be undone.',
    vaultDone: 'Done.',
    vaultNever: 'Saved passwords are never shown here.',
  },
  fa: {
    secTitle: 'درخواست ورود',
    secEntry: 'مدخل گاوصندوق',
    secRotate: 'رمز ذخیره‌شده را جایگزین می‌کند',
    secNote: 'آنچه اینجا تایپ کنید مستقیم به گاوصندوق رمزنگاری‌شده می‌رود — عامل هرگز آن را نمی‌بیند.',
    secUser: 'نام کاربری یا ایمیل',
    secPass: 'رمز عبور',
    secTotp: 'کلید راه‌اندازی تأیید دومرحله‌ای (اختیاری)',
    secSave: 'ذخیره در گاوصندوق',
    secCancel: 'لغو',
    secSaved: 'در گاوصندوق ذخیره شد.',
    secRefused: 'روی http سادهٔ شبکهٔ محلی نمی‌توان رمز تایپ کرد. مرکز کنترل را روی همین رایانه (localhost) یا از لینک https آن باز کنید.',
    secNoCrypto: 'این مرورگر نمی‌تواند فرم را رمزنگاری کند (WebCrypto ندارد). از مرورگر به‌روز استفاده کنید یا مرکز کنترل را روی همین رایانه باز کنید.',
    vault: 'گاوصندوق',
    vaultEmpty: 'هنوز ورودی ذخیره نشده است.',
    vaultAdd: 'افزودن ورود',
    vaultName: 'نام (مثلاً github)',
    vaultSites: 'سایت‌ها (مثلاً github.com)',
    vaultLoginUrl: 'آدرس صفحهٔ ورود (اختیاری)',
    vaultNewPass: 'رمز جدید (خالی = بدون تغییر)',
    vaultNewTotp: 'کلید جدید تأیید دومرحله‌ای (اختیاری)',
    vaultUserKeep: 'نام کاربری (خالی = بدون تغییر)',
    vaultRotateBtn: 'تغییر رمز',
    vaultEdit: 'ویرایش',
    vaultDelete: 'حذف',
    vaultConfirmDelete: 'ورود ذخیره‌شدهٔ «{name}» حذف شود؟ این کار برگشت‌پذیر نیست.',
    vaultDone: 'انجام شد.',
    vaultNever: 'رمزهای ذخیره‌شده هرگز اینجا نمایش داده نمی‌شوند.',
  },
};

export const SECRET_DASHBOARD_CSS = String.raw`
#secretsPanel{border-color:var(--accent)}
.scard{border:1px solid var(--border);border-radius:10px;padding:10px;margin-top:8px;background:var(--panel2)}
.scard .shost{font-weight:600;font-size:15px}
.sreason{margin:4px 0}
.smeta{color:var(--muted);font-size:12px}
.swarn{color:#fcd34d;font-size:12px;margin:4px 0}
.sfield{display:block;margin-top:6px}
.sfield span{display:block;font-size:12px;color:var(--muted)}
.sfield input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:6px 10px;direction:ltr}
.vrow{border-top:1px solid var(--border);padding:8px 0}
.vrow:first-child{border-top:0}
.vtop{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.vsites,.vuser{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.vbox:empty{display:none}
#vaultAddBox summary{cursor:pointer;color:var(--accent);margin-top:8px}
`;

/** The two panels. `tx` returns an HTML-escaped localized string. */
export function secretPanelsHtml(tx: (k: string) => string): { requests: string; vault: string } {
  const field = (id: string, key: string, type: string, ac: string) =>
    `<label class="sfield"><span data-i18n="${key}">${tx(key)}</span><input id="${id}" type="${type}" autocomplete="${ac}" spellcheck="false" autocapitalize="off" maxlength="4096"></label>`;
  return {
    requests: `<section id="secretsPanel" class="panel hidden" aria-live="polite">
    <h2 data-i18n="secTitle">${tx('secTitle')}</h2>
    <div class="smeta" data-i18n="secNote">${tx('secNote')}</div>
    <div id="secretList"></div>
  </section>`,
    vault: `<section id="vaultPanel" class="panel">
    <h2><span data-i18n="vault">${tx('vault')}</span><span id="vaultCount" class="badge"></span></h2>
    <div class="smeta" data-i18n="vaultNever">${tx('vaultNever')}</div>
    <div id="vaultList"></div>
    <details id="vaultAddBox"><summary data-i18n="vaultAdd">${tx('vaultAdd')}</summary>
      <form id="vaultAddForm" autocomplete="off">
        ${field('vaName', 'vaultName', 'text', 'off')}
        ${field('vaSites', 'vaultSites', 'text', 'off')}
        ${field('vaUser', 'secUser', 'text', 'off')}
        ${field('vaPass', 'secPass', 'password', 'new-password')}
        ${field('vaTotp', 'secTotp', 'password', 'off')}
        <div class="row"><button class="btn primary" type="submit" data-i18n="secSave">${tx('secSave')}</button></div>
      </form>
    </details>
    <div id="vaultMsg" class="msg" role="status"></div>
  </section>`,
  };
}

/** Appended inside the dashboard's IIFE (uses api, t, $, el, autoDir, errText, onBus). */
export const SECRET_DASHBOARD_SCRIPT = SECRET_SEAL_JS + String.raw`
  // ── secure login requests + vault panel (src/control/secret-dashboard.ts) ──
  var sec = { transport: '', requests: [], sig: '', vtransport: '', entries: [] };
  function secField(labelKey, type, ac) {
    var wrap = el('label', 'sfield');
    wrap.appendChild(el('span', null, t(labelKey)));
    var inp = document.createElement('input');
    inp.type = type; inp.setAttribute('autocomplete', ac); inp.setAttribute('autocapitalize', 'off');
    inp.spellcheck = false; inp.maxLength = 4096;
    wrap.appendChild(inp);
    return { wrap: wrap, input: inp };
  }
  function secMsg(node, text, isErr) { node.textContent = text || ''; node.classList.toggle('err', !!isErr); }
  // Seal when the browser can; plaintext only where the server said 'local'.
  function secBody(seal, payload, transport) {
    var c = window.crypto;
    if (c && c.subtle && seal && seal.publicKey && seal.kid) {
      return qxSealSecret(c, seal.publicKey, seal.kid, payload).then(function (s) { return { sealed: s }; });
    }
    if (transport === 'local') return Promise.resolve(payload);
    return Promise.reject(new Error(t('secNoCrypto')));
  }
  function secFind(id) {
    for (var i = 0; i < sec.requests.length; i++) if (sec.requests[i].id === id) return sec.requests[i];
    return null;
  }
  function requestCard(r) {
    var card = el('div', 'scard');
    card.appendChild(autoDir(el('div', 'shost', r.displayHost || r.host)));
    if (r.reason) card.appendChild(autoDir(el('div', 'sreason', r.reason)));
    card.appendChild(autoDir(el('div', 'smeta', t('secEntry') + ': ' + r.entryName + (r.existing ? ' — ' + t('secRotate') : ''))));
    if (r.warning) card.appendChild(autoDir(el('div', 'swarn', r.warning)));
    var msg = el('div', 'msg');
    var cancel = el('button', 'btn no', t('secCancel')); cancel.type = 'button';
    cancel.addEventListener('click', function () {
      cancel.disabled = true;
      api('POST', '/api/secrets/' + encodeURIComponent(r.id), { cancel: true })
        .then(function () { refreshSecrets(); })
        .catch(function (e) { secMsg(msg, errText(e), true); cancel.disabled = false; });
    });
    if (sec.transport === 'refused') {
      card.appendChild(el('div', 'swarn', t('secRefused')));
      var row0 = el('div', 'row'); row0.appendChild(cancel); card.appendChild(row0);
      card.appendChild(msg);
      return card;
    }
    var form = document.createElement('form'); form.setAttribute('autocomplete', 'off');
    var u = secField('secUser', 'text', 'username'); u.input.value = r.usernameHint || '';
    var p = secField('secPass', 'password', 'new-password');
    var z = (r.fields || []).indexOf('totp') >= 0 ? secField('secTotp', 'password', 'off') : null;
    form.appendChild(u.wrap); form.appendChild(p.wrap); if (z) form.appendChild(z.wrap);
    var save = el('button', 'btn primary', t('secSave')); save.type = 'submit';
    var row = el('div', 'row'); row.appendChild(cancel); row.appendChild(save); form.appendChild(row);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!p.input.value) { p.input.focus(); return; }
      save.disabled = true; secMsg(msg, '');
      var cur = secFind(r.id);
      var payload = { username: u.input.value, password: p.input.value };
      if (z && z.input.value) payload.totp = z.input.value;
      secBody(cur && cur.seal, payload, sec.transport).then(function (body) {
        payload = null;
        return api('POST', '/api/secrets/' + encodeURIComponent(r.id), body);
      }).then(function () {
        p.input.value = ''; if (z) z.input.value = '';
        secMsg(msg, t('secSaved'));
        refreshSecrets(); loadVault();
      }).catch(function (e) {
        payload = null;
        secMsg(msg, errText(e), true);
        refreshSecrets(); // a used seal key is gone: fetch a fresh one
      }).then(function () { save.disabled = false; });
    });
    card.appendChild(form);
    card.appendChild(msg);
    return card;
  }
  function renderSecrets(force) {
    var sig = lang + '|' + sec.transport + '|' + sec.requests.map(function (r) { return r.id; }).join(',');
    if (!force && sig === sec.sig) return; // keep what the human is typing
    sec.sig = sig;
    var list = $('secretList');
    list.textContent = '';
    sec.requests.forEach(function (r) { list.appendChild(requestCard(r)); });
    $('secretsPanel').classList.toggle('hidden', !sec.requests.length);
  }
  function refreshSecrets() {
    return api('GET', '/api/secrets').then(function (j) {
      sec.transport = j.transport || '';
      sec.requests = Array.isArray(j.requests) ? j.requests : [];
      renderSecrets(false);
    }).catch(function () {});
  }

  function vaultMsg(text, isErr) { secMsg($('vaultMsg'), text, isErr); }
  // add / rotate: a single-use key bound to that operation and entry, then seal.
  function panelSend(op, name, payload, extra) {
    var c = window.crypto;
    var sealing = (c && c.subtle)
      ? api('GET', '/api/vault/key?op=' + op + '&name=' + encodeURIComponent(name)).then(function (k) { return secBody(k, payload, sec.vtransport); })
      : secBody(null, payload, sec.vtransport);
    return sealing.then(function (body) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
      return api('POST', '/api/vault/' + op, body);
    });
  }
  function vaultRow(e) {
    var row = el('div', 'vrow');
    var top = el('div', 'vtop');
    top.appendChild(autoDir(el('b', null, e.name)));
    top.appendChild(el('span', 'vsites', (e.origins || []).join(', ')));
    if (e.user) top.appendChild(autoDir(el('span', 'vuser', e.user)));
    if (e.fields && e.fields.totp) top.appendChild(el('span', 'badge', '2FA'));
    row.appendChild(top);
    var acts = el('div', 'row');
    var rot = el('button', 'btn', t('vaultRotateBtn')); rot.type = 'button';
    var ed = el('button', 'btn', t('vaultEdit')); ed.type = 'button';
    var del = el('button', 'btn no', t('vaultDelete')); del.type = 'button';
    acts.appendChild(rot); acts.appendChild(ed); acts.appendChild(del);
    row.appendChild(acts);
    var box = el('div', 'vbox');
    row.appendChild(box);
    function openForm(fields, onSave) {
      box.textContent = '';
      var form = document.createElement('form'); form.setAttribute('autocomplete', 'off');
      fields.forEach(function (f) { form.appendChild(f.wrap); });
      var cancel = el('button', 'btn', t('secCancel')); cancel.type = 'button';
      cancel.addEventListener('click', function () { box.textContent = ''; });
      var save = el('button', 'btn primary', t('secSave')); save.type = 'submit';
      var r = el('div', 'row'); r.appendChild(cancel); r.appendChild(save); form.appendChild(r);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        save.disabled = true; vaultMsg('');
        onSave().then(function () { box.textContent = ''; vaultMsg(t('vaultDone')); loadVault(); })
          .catch(function (x) { vaultMsg(errText(x), true); })
          .then(function () { save.disabled = false; });
      });
      box.appendChild(form);
      if (fields[0]) fields[0].input.focus();
    }
    rot.addEventListener('click', function () {
      var p = secField('vaultNewPass', 'password', 'new-password');
      var z = secField('vaultNewTotp', 'password', 'off');
      openForm([p, z], function () {
        var payload = {};
        if (p.input.value) payload.password = p.input.value;
        if (z.input.value) payload.totp = z.input.value;
        return panelSend('rotate', e.name, payload, { name: e.name }).then(function (j) { p.input.value = ''; z.input.value = ''; return j; });
      });
    });
    ed.addEventListener('click', function () {
      var s = secField('vaultSites', 'text', 'off'); s.input.value = (e.origins || []).join(', ');
      var u = secField('vaultUserKeep', 'text', 'off');
      var l = secField('vaultLoginUrl', 'text', 'off'); l.input.value = e.loginUrl || '';
      openForm([s, u, l], function () {
        var body = { name: e.name };
        if (s.input.value.trim() !== (e.origins || []).join(', ')) body.origins = s.input.value;
        if (u.input.value.trim()) body.username = u.input.value.trim();
        if (l.input.value.trim() !== (e.loginUrl || '')) body.loginUrl = l.input.value.trim();
        return api('POST', '/api/vault/edit', body);
      });
    });
    del.addEventListener('click', function () {
      if (!window.confirm(t('vaultConfirmDelete').replace('{name}', e.name))) return;
      del.disabled = true;
      api('POST', '/api/vault/remove', { name: e.name, confirm: e.name })
        .then(function () { vaultMsg(t('vaultDone')); loadVault(); })
        .catch(function (x) { vaultMsg(errText(x), true); del.disabled = false; });
    });
    return row;
  }
  function renderVault() {
    var list = $('vaultList');
    list.textContent = '';
    var refused = sec.vtransport === 'refused';
    $('vaultAddBox').classList.toggle('hidden', refused);
    $('vaultCount').textContent = sec.entries.length ? String(sec.entries.length) : '';
    if (refused) { list.appendChild(el('div', 'swarn', t('secRefused'))); return; }
    if (!sec.entries.length) { list.appendChild(el('div', 'empty', t('vaultEmpty'))); return; }
    sec.entries.forEach(function (e) { list.appendChild(vaultRow(e)); });
  }
  function loadVault() {
    return api('GET', '/api/vault').then(function (j) {
      sec.vtransport = j.transport || '';
      sec.entries = Array.isArray(j.entries) ? j.entries : [];
      renderVault();
    }).catch(function (x) { vaultMsg(errText(x), true); });
  }
  $('vaultAddForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = $('vaName').value.trim(), sites = $('vaSites').value.trim();
    if (!name || !sites || !$('vaPass').value) { vaultMsg(t('failed'), true); return; }
    var payload = { username: $('vaUser').value.trim(), password: $('vaPass').value };
    if ($('vaTotp').value.trim()) payload.totp = $('vaTotp').value.trim();
    var btn = ev.target.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    vaultMsg('');
    panelSend('add', name, payload, { name: name, origins: sites }).then(function () {
      $('vaName').value = ''; $('vaSites').value = ''; $('vaUser').value = ''; $('vaPass').value = ''; $('vaTotp').value = '';
      $('vaultAddBox').open = false;
      vaultMsg(t('vaultDone')); loadVault();
    }).catch(function (x) { vaultMsg(errText(x), true); })
      .then(function () { if (btn) btn.disabled = false; });
  });
  $('langBtn').addEventListener('click', function () { renderSecrets(true); renderVault(); });
  // The broker announces requests with a metadata-only notice: refresh at once.
  // A hand-off page (opened from a scoped hand-off link, or ?handoff=) is the live view of
  // one bot check and nothing else: no secret requests, no vault panel, no polling.
  if (HO) {
    ['secretsPanel', 'vaultPanel'].forEach(function (id) { var p = document.getElementById(id); if (p) p.hidden = true; });
  } else {
    var qxBusBase = onBus;
    onBus = function (ev) {
      qxBusBase(ev);
      if (ev && ev.kind === 'notice' && /🔐/.test(String(ev.message || ''))) refreshSecrets();
    };
    refreshSecrets();
    loadVault();
    setInterval(function () { if (!document.hidden) refreshSecrets(); }, 4000);
  }
`;
