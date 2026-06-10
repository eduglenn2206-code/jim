/* patron-store.js — shared aggregation + settings layer
 * Reads existing per-page localStorage silos; never moves or deletes them.
 * Writes route back to those same canonical keys so every category page stays in sync.
 * One new key: patron_settings_v1 (macro targets + future settings)
 */
(function () {
  'use strict';

  // ─── date helpers ──────────────────────────────────────────────────────────
  function localDateKey(d) {
    const t = d || new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const day = String(t.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // supplements / goals use a 6 AM rollover; everything else uses local midnight
  function activeDateKey6am(d) {
    const t = new Date(d || Date.now());
    if (t.getHours() < 6) t.setDate(t.getDate() - 1);
    return localDateKey(t);
  }

  // ─── localStorage helpers ──────────────────────────────────────────────────
  function lsGet(key) {
    try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  // ─── settings ─────────────────────────────────────────────────────────────
  const SETTINGS_KEY = 'patron_settings_v1';
  const MACRO_DEFAULTS = {
    calories: 2200,
    proteinGoal: 150,
    proteinMinimum: 130,
    proteinUsefulLimit: 170,
    fatGoal: 55,
    fatMinimum: 48,
    fatIdealMin: 50,
    fatIdealMax: 60,
    carbMode: 'auto',
    carbGoal: 270,
  };

  function settings() {
    let s = lsGet(SETTINGS_KEY) || {};
    // one-time migration: seed calories from macros page goal if it exists
    if (!s._migrated) {
      const macStore = lsGet('macros_standalone_v1');
      if (macStore && macStore.goalCal) {
        s.macroTargets = Object.assign({}, MACRO_DEFAULTS, { calories: Number(macStore.goalCal) || 2200 }, s.macroTargets || {});
      }
      s._migrated = true;
      lsSet(SETTINGS_KEY, s);
    }
    s.macroTargets = Object.assign({}, MACRO_DEFAULTS, s.macroTargets || {});
    return s;
  }

  function saveSettings(patch) {
    const s = settings();
    Object.assign(s, patch);
    lsSet(SETTINGS_KEY, s);
  }

  function macroTargets() {
    const t = settings().macroTargets;
    if (t.carbMode === 'auto') {
      t.carbGoal = Math.round((t.calories - t.proteinGoal * 4 - t.fatGoal * 9) / 4);
    }
    return t;
  }

  // ─── reads ─────────────────────────────────────────────────────────────────
  function dailyLog(dateKey) {
    const dk = dateKey || localDateKey();

    // weight — progress_standalone_v1 .entries[] {dateKey, weightKg, time?, note?}
    let weight = null;
    try {
      const prog = lsGet('progress_standalone_v1');
      if (prog && Array.isArray(prog.entries)) {
        const entry = prog.entries.find(e => e && e.dateKey === dk);
        if (entry && entry.weightKg != null) {
          const kg = Number(entry.weightKg);
          const unit = (prog.units) || 'kg';
          weight = { kg, lb: Math.round(kg * 2.20462 * 10) / 10, unit, loggedAt: entry.time || null };
        }
      }
    } catch {}

    // macros — macros_standalone_v1[dateKey] = [{cal,p,c,f,...}]
    let macros = { cal: 0, protein: 0, carbs: 0, fat: 0, entries: [] };
    try {
      const macStore = lsGet('macros_standalone_v1');
      if (macStore && Array.isArray(macStore[dk])) {
        macStore[dk].forEach(e => {
          macros.cal += Number(e.cal) || 0;
          macros.protein += Number(e.p) || 0;
          macros.carbs += Number(e.c) || 0;
          macros.fat += Number(e.f) || 0;
        });
        macros.entries = macStore[dk];
      }
    } catch {}

    // water — water_standalone_v1 .logs {dateKey: count} — uses local midnight key
    let water = { count: 0, goal: 8, ml: 0 };
    try {
      const wStore = lsGet('water_standalone_v1');
      if (wStore) {
        const count = wStore.logs ? (wStore.logs[dk] || 0) : 0;
        const unitMl = wStore.unit === 'glass' ? (wStore.glassMl || 250) : (wStore.bottleMl || 500);
        const goal = wStore.unit === 'glass'
          ? Math.max(1, Math.ceil((wStore._targetMl || 2500) / unitMl))
          : Math.max(1, Math.ceil((wStore._targetMl || 2500) / unitMl));
        water = { count, goal, ml: count * unitMl, unit: wStore.unit || 'bottle', unitMl };
      }
    } catch {}

    // supplements — supplements_standalone_v1 {items:[], taken:{dateKey:{id:bool}}}
    // supplements use 6AM rollover, but we also check the plain dk for the aggregation layer
    let supplements = { completed: [], total: 0, done: false };
    try {
      const supStore = lsGet('supplements_standalone_v1');
      if (supStore && Array.isArray(supStore.items)) {
        const supDk = activeDateKey6am(); // for today-reads, use 6am rollover key
        const takenKey = (dateKey && dateKey !== localDateKey()) ? dk : supDk;
        const takenMap = (supStore.taken && supStore.taken[takenKey]) || {};
        const ids = supStore.items.filter(i => takenMap[i.id]).map(i => i.id);
        supplements = {
          completed: ids,
          total: supStore.items.length,
          done: supStore.items.length > 0 && ids.length >= supStore.items.length,
        };
      }
    } catch {}

    // gym — po_coach_workout_done {dateKey: true/false} + po_coach_v1 for day type
    let gym = { trained: false, dayType: null, exercises: [] };
    try {
      const doneMap = lsGet('po_coach_workout_done') || {};
      gym.trained = !!(doneMap[dk]);
      const coach = lsGet('po_coach_v1');
      if (coach) {
        // find the day type configured for this day of the week
        const dow = new Date(dk + 'T12:00:00').getDay(); // 0=Sun
        const days = coach.days;
        if (days && Array.isArray(days)) {
          const dayEntry = days.find(d => d.dow === dow);
          if (dayEntry) gym.dayType = dayEntry.type || null;
        }
        // logged exercises for this date
        const workouts = coach.workouts;
        if (workouts && Array.isArray(workouts[dk])) {
          gym.exercises = workouts[dk];
        }
      }
    } catch {}

    // goals — goals:dateKey (6am rollover for today, plain dk otherwise)
    let goals = [];
    try {
      const goalsDk = (dateKey && dateKey !== localDateKey()) ? dk : activeDateKey6am();
      const raw = lsGet('goals:' + goalsDk);
      if (Array.isArray(raw)) goals = raw;
    } catch {}

    return { weight, macros, water, supplements, gym, goals };
  }

  function today() { return dailyLog(localDateKey()); }

  function range(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dk = localDateKey(d);
      out.push({ dateKey: dk, log: dailyLog(dk) });
    }
    return out;
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  function logWeight(kg) {
    const dk = localDateKey();
    const prog = lsGet('progress_standalone_v1') || { entries: [], units: 'kg' };
    if (!Array.isArray(prog.entries)) prog.entries = [];
    const idx = prog.entries.findIndex(e => e && e.dateKey === dk);
    const entry = { dateKey: dk, weightKg: Number(kg), time: new Date().toISOString() };
    if (idx >= 0) prog.entries[idx] = entry;
    else prog.entries.push(entry);
    lsSet('progress_standalone_v1', prog);
  }

  function logMacros(obj) {
    // obj: {cal, p, c, f, name?}
    const dk = localDateKey();
    const store = lsGet('macros_standalone_v1') || {};
    if (!Array.isArray(store[dk])) store[dk] = [];
    store[dk].push({
      name: obj.name || 'Check-in entry',
      cal: Number(obj.cal) || 0,
      p: Number(obj.p) || 0,
      c: Number(obj.c) || 0,
      f: Number(obj.f) || 0,
      manual: true,
      _ts: Date.now(),
    });
    lsSet('macros_standalone_v1', store);
  }

  function setWater(count) {
    const dk = localDateKey();
    const store = lsGet('water_standalone_v1');
    if (!store) return;
    if (!store.logs) store.logs = {};
    store.logs[dk] = Math.max(0, count);
    lsSet('water_standalone_v1', store);
  }

  function addWater(delta) {
    const dk = localDateKey();
    const store = lsGet('water_standalone_v1');
    if (!store) return;
    if (!store.logs) store.logs = {};
    store.logs[dk] = Math.max(0, (store.logs[dk] || 0) + delta);
    lsSet('water_standalone_v1', store);
  }

  function setSupplementDone(id, bool) {
    const dk = activeDateKey6am();
    const store = lsGet('supplements_standalone_v1');
    if (!store) return;
    if (!store.taken) store.taken = {};
    if (!store.taken[dk]) store.taken[dk] = {};
    if (bool) store.taken[dk][id] = true;
    else delete store.taken[dk][id];
    lsSet('supplements_standalone_v1', store);
  }

  function setGymTrained(bool, dayType) {
    const dk = localDateKey();
    const doneMap = lsGet('po_coach_workout_done') || {};
    if (bool) doneMap[dk] = true;
    else delete doneMap[dk];
    lsSet('po_coach_workout_done', doneMap);
    if (dayType) {
      const coach = lsGet('po_coach_v1');
      if (coach) {
        const dow = new Date().getDay();
        if (Array.isArray(coach.days)) {
          const d = coach.days.find(d => d.dow === dow);
          if (d) d.type = dayType;
        }
        lsSet('po_coach_v1', coach);
      }
    }
  }

  function addGoal(text) {
    const dk = activeDateKey6am();
    const key = 'goals:' + dk;
    const list = lsGet(key) || [];
    list.push({ text: String(text).trim(), done: false });
    lsSet(key, list);
  }

  function toggleGoal(i) {
    const dk = activeDateKey6am();
    const key = 'goals:' + dk;
    const list = lsGet(key) || [];
    if (list[i]) list[i].done = !list[i].done;
    lsSet(key, list);
  }

  // ─── export ────────────────────────────────────────────────────────────────
  window.PatronStore = {
    // date helpers (exposed for pages that want to use the canonical format)
    localDateKey,
    activeDateKey6am,
    TODAY_KEY: localDateKey(),

    // reads
    dailyLog,
    today,
    range,

    // writes
    logWeight,
    logMacros,
    setWater,
    addWater,
    setSupplementDone,
    setGymTrained,
    addGoal,
    toggleGoal,

    // settings
    settings,
    saveSettings,
    macroTargets,
  };
})();
