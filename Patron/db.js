/* ============================================================
 * db.js — shared cloud sync for the Patron / Vitality suite.
 *
 * Matches the pattern the Gym page already uses: one Supabase
 * table called `app_state` holding { key, data, updated_at }.
 * Each page saves its blob under its own key (e.g. 'po-coach' for
 * Gym, 'patron-profile', 'patron-macros'). NO login — the user's
 * own Supabase keys (saved once in Settings) are the identity, so
 * their phone + laptop sync just by using the same project.
 *
 * Include once per page, AFTER the Supabase library:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="db.js"></script>
 *
 * If no Supabase keys are saved, everything falls back to
 * localStorage (this device only) so the app never breaks.
 *
 * Setup SQL + the "paste your keys" flow live in README.md
 * (Gym → ⚙ Settings → Cloud sync).
 * ============================================================ */
window.PatronDB = (function () {
  // Key resolution order (first non-empty wins):
  //   1. localStorage override (user pasted their own keys via ☁ panel)
  //   2. /api/config         (this deploy's Vercel env vars — keys live there,
  //                           NOT in this repo, so nothing is committed publicly)
  // No keys are hardcoded here. A fresh deploy with no env vars set stays
  // local-only until the user adds keys (env var or the ☁ panel).
  const _ovUrl = (localStorage.getItem('po_supabase_url') || '').trim();
  const _ovKey = (localStorage.getItem('po_supabase_key') || '').trim();

  let URL = _ovUrl;
  let KEY = _ovKey;
  let ready = false;
  let sb = null;
  let _syncStarted = false;

  function _connect(u, k) {
    ready = !!(u && k && window.supabase && u.indexOf('PASTE-') !== 0);
    sb = ready ? window.supabase.createClient(u, k) : null;
  }
  // Starts the universal syncer once we have a live cloud connection. Idempotent.
  function _startSync() {
    if (_syncStarted || !ready) return;
    _syncStarted = true;
    _autoSync();
  }
  _connect(URL, KEY); // synchronous boot — identical behavior to before

  // If the user hasn't pasted their own keys, fetch this deploy's config from the
  // server (Vercel env vars) and connect. Forkers with no env vars set get
  // {url:'',key:''} → app stays local-only until they add their own keys.
  (async function _loadConfig() {
    if (_ovUrl && _ovKey) return; // user override already wins
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (!r.ok) return;
      const cfg = await r.json();
      const u = (cfg && cfg.url || '').trim(), k = (cfg && cfg.key || '').trim();
      if (u && k && (u !== URL || k !== KEY)) { URL = u; KEY = k; _connect(u, k); _startSync(); }
    } catch (_) {}
  })();

  function isCloud() { return ready; }
  function cfgUrl() { return URL || ''; }
  function cfgKey() { return KEY || ''; }

  /* ---- read a blob by key (cloud if configured, else this browser) ---- */
  async function get(key) {
    if (!sb) return _local(key);
    try {
      const { data, error } = await sb.from('app_state').select('data').eq('key', key).maybeSingle();
      if (!error && data && data.data) return data.data;
    } catch (_) {}
    return _local(key); // fall back if the network/row is missing
  }

  /* ---- write a blob by key (saves to cloud AND this browser) ---- */
  async function set(key, value) {
    _saveLocal(key, value); // always keep a local copy
    if (!sb) return;
    try {
      await sb.from('app_state').upsert(
        { key, data: value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch (_) {}
  }

  /* ---- live updates from other devices ---- */
  function subscribe(key, cb) {
    if (!sb) return function () {};
    const ch = sb.channel('app_state_' + key)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + key },
        payload => { if (payload.new && payload.new.data) cb(payload.new.data); })
      .subscribe();
    return function () { try { sb.removeChannel(ch); } catch (_) {} };
  }

  /* ---- image upload to Supabase Storage (for progress photos) ----
   * Returns a public URL on success, or null (caller falls back to base64).
   * This is the fix for "photos never stick": files go to a Storage bucket,
   * and only the small URL is saved in app_state — never giant base64 blobs. */
  async function uploadImage(bucket, path, dataUrl, contentType) {
    if (!sb) return null;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: contentType || 'image/jpeg', upsert: true });
      if (error) return null;
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return (data && data.publicUrl) ? data.publicUrl : null;
    } catch (_) { return null; }
  }
  async function deleteImage(bucket, path) {
    if (!sb || !path) return;
    try { await sb.storage.from(bucket).remove([path]); } catch (_) {}
  }

  /* ---- localStorage fallback helpers ---- */
  function _local(key) { try { return JSON.parse(localStorage.getItem('patron_db_' + key) || 'null'); } catch (_) { return null; } }
  function _saveLocal(key, v) { try { localStorage.setItem('patron_db_' + key, JSON.stringify(v)); } catch (_) {} }

  /* ============================================================
   * UNIVERSAL AUTO-SYNC — the same approach the Progress tab uses, applied to
   * EVERYTHING with no per-page key list. We simply mirror every localStorage
   * entry to a cloud row of the same name, both directions. No page needs to
   * register anything; whatever a page saves locally is synced automatically.
   *
   * Excluded (never synced): the Supabase keys themselves, db.js's own local
   * mirror, and per-page session flags — none of those belong on other devices.
   * ============================================================ */
  function _skip(k) {
    return !k
      || k.indexOf('po_supabase') === 0      // this device's cloud credentials
      || k.indexOf('patron_db_') === 0       // db.js get()/set() local fallback mirror
      || k.indexOf('patron_hydrated_') === 0 // per-session hydrate flag
      || k === 'patron_theme';               // theme is a per-device preference
  }
  async function _cloudGet(key) {
    if (!sb) return undefined;
    try { const { data, error } = await sb.from('app_state').select('data').eq('key', key).maybeSingle(); if (!error && data) return data.data; } catch (_) {}
    return undefined;
  }
  function _cloudSet(key, value) {
    if (!sb) return;
    try { sb.from('app_state').upsert({ key, data: value, updated_at: new Date().toISOString() }, { onConflict: 'key' }); } catch (_) {}
  }
  // Every cloud row, as a {key: data} map. One round-trip to reconcile everything.
  async function _cloudGetAll() {
    const m = {};
    if (!sb) return m;
    try { const { data, error } = await sb.from('app_state').select('key,data'); if (!error && data) data.forEach(function (r) { m[r.key] = r.data; }); } catch (_) {}
    return m;
  }
  // Canonicalize a JSON string so key-order differences don't look like edits.
  function _canon(s) { if (s == null) return s; try { return JSON.stringify(JSON.parse(s)); } catch (_) { return s; } }

  function _autoSync() {
    const flag = 'patron_hydrated_' + location.pathname;
    const last = {}; // canonical string we believe is synced with cloud, per key

    // One-time guard so the first-load reload can NEVER loop, even if pull() keeps
    // reporting a change. Lives in sessionStorage (per tab/session).
    const reloadFlag = 'patron_initreload_' + location.pathname;
    function _didInitialReload() { try { return !!sessionStorage.getItem(reloadFlag); } catch (_) { return true; } }
    function _markInitialReload() { try { sessionStorage.setItem(reloadFlag, '1'); } catch (_) {} }

    // Push every changed local entry up to the cloud. Re-enumerates localStorage
    // each tick, so keys created later (e.g. a new day's goals) are picked up too.
    function pushChanged() {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (_skip(k)) continue;
        const v = localStorage.getItem(k);
        if (v == null) continue;
        const c = _canon(v);
        if (c !== last[k]) {
          last[k] = c;
          let val; try { val = JSON.parse(v); } catch (_) { val = v; }
          _cloudSet(k, val);
        }
      }
    }

    // Pull every cloud row down. Skips a key that has unpushed local edits (so we
    // never clobber what you just changed). Seeds the cloud from any local-only
    // key. Returns true if any local value changed (caller reloads to show it).
    async function pull(seedIfMissing) {
      let changed = false;
      const cloud = await _cloudGetAll();
      // 1) cloud → local
      for (const k in cloud) {
        if (_skip(k)) continue;
        const localStr = localStorage.getItem(k);
        const localCanon = localStr == null ? undefined : _canon(localStr);
        const pendingEdit = (last[k] !== undefined && localCanon !== last[k]);
        if (pendingEdit) continue;
        const remote = cloud[k];
        if (remote === undefined || remote === null) continue;
        const rstr = (typeof remote === 'string') ? remote : JSON.stringify(remote);
        const rcanon = _canon(rstr);
        if (rcanon !== localCanon) { try { localStorage.setItem(k, rstr); } catch (_) {} changed = true; }
        last[k] = rcanon;
      }
      // 2) seed cloud from any local key it doesn't have yet
      if (seedIfMissing) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (_skip(k) || (k in cloud)) continue;
          const localStr = localStorage.getItem(k);
          if (localStr == null) continue;
          let val; try { val = JSON.parse(localStr); } catch (_) { val = localStr; }
          _cloudSet(k, val);
          last[k] = _canon(localStr);
        }
      }
      return changed;
    }

    (async function () {
      // Baseline = everything on this device right now, so pull() can tell a real
      // local edit apart from data we just adopted from the cloud.
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (_skip(k)) continue;
        const ls = localStorage.getItem(k);
        last[k] = ls == null ? undefined : _canon(ls);
      }
      // FIRST LOAD ONLY: adopt the cloud copy before the page renders, then let
      // it render once. This reload happens before you've interacted, so it can't
      // eat anything. Guarded by a per-session flag so it runs at most once.
      try {
        if (!sessionStorage.getItem(flag)) {
          const changed = await pull(true); // cloud wins on fresh load; seed if empty
          sessionStorage.setItem(flag, '1');
          if (changed && !_didInitialReload()) { _markInitialReload(); location.reload(); return; }
        }
      } catch (_) {}
      // Keep pushing your saves up continuously. NEVER reloads — so typing is safe.
      setInterval(pushChanged, 2000);
      // Pull other devices' edits when you return to this tab. We update
      // localStorage SILENTLY and do NOT reload (reloading mid-use was wiping
      // in-progress typing). Always flush your own edits up first so they win.
      let pulling = false;
      async function refresh() {
        if (pulling || document.hidden) return;
        pulling = true;
        try { pushChanged(); await pull(false); } catch (_) {}
        pulling = false;
      }
      document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
      window.addEventListener('focus', refresh);
    })();
  }
  _startSync(); // synchronous case (pasted keys); async config loader covers the env-var case

  /* ---- MANUAL sync — explicit, can't-miss buttons (used by cloud-sync.js) ----
   * pushAll(): force every local entry up to the cloud right now.
   * pullAll(): force every cloud entry down to this device, then reload. */
  async function pushAll() {
    if (!sb) return { ok: false, n: 0 };
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (_skip(k)) continue;
      const v = localStorage.getItem(k);
      if (v == null) continue;
      let val; try { val = JSON.parse(v); } catch (_) { val = v; }
      try { await sb.from('app_state').upsert({ key: k, data: val, updated_at: new Date().toISOString() }, { onConflict: 'key' }); n++; } catch (_) {}
    }
    return { ok: true, n: n };
  }
  async function pullAll() {
    if (!sb) return { ok: false, n: 0 };
    let n = 0;
    const cloud = await _cloudGetAll();
    for (const k in cloud) {
      if (_skip(k)) continue;
      const remote = cloud[k];
      if (remote === undefined || remote === null) continue;
      const rstr = (typeof remote === 'string') ? remote : JSON.stringify(remote);
      try { localStorage.setItem(k, rstr); n++; } catch (_) {}
    }
    try { sessionStorage.setItem('patron_hydrated_' + location.pathname, '1'); } catch (_) {}
    return { ok: true, n: n };
  }

  return { isCloud, cfgUrl, cfgKey, get, set, subscribe, uploadImage, deleteImage, pushAll, pullAll };
})();
