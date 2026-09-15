/* views-schedule: the normal week — what a contract runs, and when a child travels
 *
 * Everything here describes what is SUPPOSED to happen. Once a week is set up
 * the calendar generates those journeys by itself, and staff only ever record
 * the days that differ.
 */
'use strict';
const Sched = window.Sched = {};

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = { 0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday' };
const DAY_SHORT = { 0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };
Sched.DAY_ORDER = DAY_ORDER;
Sched.DAY_NAMES = DAY_NAMES;
Sched.DAY_SHORT = DAY_SHORT;

const KINDS = [
  { value: 'outbound', label: 'Out — home to school' },
  { value: 'return', label: 'Back — school to home' },
  { value: 'other', label: 'Other journey' },
];

/* =========================================================
   CONTRACT — NORMAL WEEKLY SCHEDULE
   ========================================================= */

/** The panel on the contract page. `week` is the contract's `week` summary. */
Sched.weekPanel = function (contract, week, reload) {
  const rows = h('div', { class: 'weekgrid' });
  for (const d of week.days) {
    const n = d.trip_count;
    rows.appendChild(h('div', { class: 'weekrow' + (n === 0 ? ' none' : '') },
      h('div', { class: 'wd' }, DAY_SHORT[d.weekday]),
      h('div', { class: 'wn' }, n === 0 ? 'Does not run' : plural(n, 'Trip')),
      h('div', { class: 'wt' }, n === 0 ? '' : d.trips.map((t, i) => h('span', { class: 'wtrip' },
        t.depart_time ? h('strong', fmt.time(t.depart_time)) : null,
        ' ' + t.label,
        t.child_ids && t.child_ids.length ? h('em', ` · ${plural(t.child_ids.length, 'child', 'children')} only`) : null,
        i < d.trips.length - 1 ? h('span', { class: 'wsep' }, '·') : null)))));
  }

  const explain = !week.configured
    ? 'Using the standard week: one journey out and one back on each operating day. Set a weekly schedule if any day is different.'
    : week.starts_on
      ? `This pattern starts on ${fmt.date(week.starts_on)}. Until then the contract runs its standard week.`
      : `In force from ${fmt.date(week.effective_from)}. A normal day on this contract is ${plural(week.normal_trips, 'journey')}.`;

  return UI.card('Normal weekly schedule',
    h('div', null,
      h('div', { class: 'note-box' + (week.starts_on ? ' warn' : ''), style: 'margin-bottom:10px' }, explain,
        week.note ? h('div', { style: 'margin-top:4px;color:var(--text-dim)' }, week.note) : null,
        week.upcoming ? h('div', { style: 'margin-top:4px' }, `A new pattern takes over on ${fmt.date(week.upcoming.effective_from)}.`) : null),
      rows,
      h('div', { style: 'margin-top:10px;font-size:12px;color:var(--text-faint)' },
        'The operations calendar generates these journeys automatically. Record an exception only when a day differs.')),
    App.can('edit') ? h('button', { class: 'btn sm primary', onclick: () => Sched.weekEditor(contract, reload) }, week.configured ? 'Edit weekly schedule' : 'Set up weekly schedule') : null);
};

/** Builds the editable model from whichever version is being edited. */
function blankTrip(kind) {
  return { label: kind === 'return' ? 'PM school collection' : 'AM school drop-off', kind: kind || 'outbound', depart_time: '', arrive_time: '', driver_pay: '', pa_pay: '', income: '', child_ids: [] };
}

Sched.weekEditor = async function (contract, reload) {
  const loading = UI.modal({ title: 'Loading the weekly schedule…', body: h('div', { class: 'loading' }, h('span', { class: 'spinner' })) });
  let data;
  try { data = await api.get(`/api/contracts/${contract.id}/schedule`); }
  catch (e) { loading.close(); return toast(e.message, 'err'); }
  loading.close();

  const children = data.children;
  const inForce = data.versions.find(v => v.in_force) || data.versions[0] || null;

  // The starting point: the version in force, or the standard week the contract
  // already runs, so the firm edits what they can see rather than a blank page.
  const model = {};
  for (const wd of DAY_ORDER) model[wd] = [];
  if (inForce) {
    for (const d of inForce.days) {
      model[d.weekday] = d.trips.map(t => ({
        label: t.label, kind: t.kind, depart_time: t.depart_time || '', arrive_time: t.arrive_time || '',
        driver_pay: t.driver_pay ?? '', pa_pay: t.pa_pay ?? '', income: t.income ?? '',
        child_ids: (t.child_ids || []).slice(),
      }));
    }
  } else {
    for (const d of data.summary.days) {
      model[d.weekday] = d.trips.map(t => ({
        label: t.label, kind: t.kind, depart_time: t.depart_time || '', arrive_time: t.arrive_time || '',
        driver_pay: '', pa_pay: '', income: '', child_ids: [],
      }));
    }
  }

  const fromInput = h('input', { type: 'date', value: inForce ? inForce.effective_from : D.today() });
  const noteInput = h('input', { type: 'text', value: inForce ? (inForce.note || '') : '', placeholder: 'e.g. Autumn term' });
  const daysWrap = h('div');

  function draw() {
    daysWrap.innerHTML = '';
    for (const wd of DAY_ORDER) {
      const trips = model[wd];
      const list = h('div', { class: 'schedule-trips' });
      trips.forEach((t, i) => list.appendChild(tripRow(wd, t, i)));
      daysWrap.appendChild(h('div', { class: 'schedule-day' + (trips.length ? '' : ' empty') },
        h('div', { class: 'sd-head' },
          h('div', { class: 'sd-name' }, DAY_NAMES[wd]),
          h('div', { class: 'sd-count' }, trips.length ? plural(trips.length, 'Trip') : 'Does not run'),
          h('div', { class: 'pill-row' },
            h('button', { class: 'btn xs', onclick: () => { model[wd].push(blankTrip(trips.length % 2 ? 'return' : 'outbound')); draw(); } }, '+ Add journey'),
            trips.length ? h('button', { class: 'btn xs', onclick: () => { model[wd] = []; draw(); } }, 'Clear day') : null,
            wd === 1 && trips.length ? h('button', { class: 'btn xs', onclick: copyMondayToWeekdays }, 'Copy to Tue–Fri') : null)),
        trips.length ? list : null));
    }
  }

  function copyMondayToWeekdays() {
    for (const wd of [2, 3, 4, 5]) {
      model[wd] = model[1].map(t => ({ ...t, child_ids: t.child_ids.slice() }));
    }
    draw();
    toast('Monday copied to Tuesday–Friday', 'ok');
  }

  function tripRow(wd, t, i) {
    const label = h('input', { type: 'text', value: t.label, placeholder: 'Journey name', oninput: e => { t.label = e.target.value; } });
    const kind = h('select', ...KINDS.map(k => h('option', { value: k.value, selected: k.value === t.kind }, k.label)));
    kind.onchange = e => { t.kind = e.target.value; };
    const depart = h('input', { type: 'time', value: t.depart_time || '', oninput: e => { t.depart_time = e.target.value; } });
    const arrive = h('input', { type: 'time', value: t.arrive_time || '', oninput: e => { t.arrive_time = e.target.value; } });

    const detail = h('div', { class: 'sd-detail', hidden: true });
    const whoLabel = h('span', { class: 'sd-who' });
    const drawWho = () => {
      whoLabel.textContent = t.child_ids.length
        ? `${t.child_ids.length} of ${children.length} children`
        : 'Everyone travelling that day';
    };
    drawWho();
    if (children.length) {
      detail.appendChild(h('div', { class: 'sd-field full' },
        h('label', 'Which children are on this journey'),
        h('div', { class: 'daypicker' },
          h('label', h('input', {
            type: 'checkbox', checked: t.child_ids.length === 0,
            onchange: e => {
              if (e.target.checked) t.child_ids = [];
              drawWho();
              for (const box of detail.querySelectorAll('input[data-child]')) box.checked = e.target.checked ? false : box.checked;
            },
          }), h('span', 'Everyone')),
          ...children.map(ch => h('label', h('input', {
            type: 'checkbox', dataset: { child: ch.id }, checked: t.child_ids.includes(ch.id),
            onchange: e => {
              const id = Number(ch.id);
              if (e.target.checked) { if (!t.child_ids.includes(id)) t.child_ids.push(id); }
              else t.child_ids = t.child_ids.filter(x => x !== id);
              const everyone = detail.querySelector('input:not([data-child])');
              if (everyone) everyone.checked = t.child_ids.length === 0;
              drawWho();
            },
          }), h('span', ch.first_name)))),
        h('div', { class: 'help' }, 'Leave as Everyone unless only some children are on this run, like an early college collection.')));
    }
    for (const [key, text, help] of [
      ['driver_pay', 'Driver pay for this journey (£)', 'Leave blank to use a share of the contract day rate.'],
      ['pa_pay', 'PA pay for this journey (£)', ''],
      ['income', 'Income for this journey (£)', ''],
    ]) {
      detail.appendChild(h('div', { class: 'sd-field' },
        h('label', text),
        h('input', { type: 'number', step: '0.01', value: t[key] ?? '', placeholder: 'Default', oninput: e => { t[key] = e.target.value; } }),
        help ? h('div', { class: 'help' }, help) : null));
    }

    const more = h('button', { class: 'btn xs' }, 'Who and pay');
    more.onclick = () => { detail.hidden = !detail.hidden; more.textContent = detail.hidden ? 'Who and pay' : 'Hide'; };

    return h('div', { class: 'sd-trip' },
      h('div', { class: 'sd-num' }, i + 1),
      h('div', { class: 'sd-main' },
        h('div', { class: 'sd-line' },
          h('div', { class: 'sd-field grow' }, h('label', 'Journey name'), label),
          h('div', { class: 'sd-field' }, h('label', 'Type'), kind),
          h('div', { class: 'sd-field' }, h('label', 'Departs'), depart),
          h('div', { class: 'sd-field' }, h('label', 'Arrives'), arrive)),
        h('div', { class: 'sd-line sub' }, whoLabel, more,
          i > 0 ? h('button', { class: 'btn xs', title: 'Move earlier', onclick: () => { const a = model[wd]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; draw(); } }, '↑') : null,
          i < model[wd].length - 1 ? h('button', { class: 'btn xs', title: 'Move later', onclick: () => { const a = model[wd]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; draw(); } }, '↓') : null,
          h('button', { class: 'btn xs danger', onclick: () => { model[wd].splice(i, 1); draw(); } }, 'Remove')),
        detail));
  }

  draw();

  const saveBtn = h('button', { class: 'btn primary' }, 'Save weekly schedule');
  const versionsBox = data.versions.length
    ? h('div', { class: 'sd-versions' },
      h('strong', 'Saved patterns: '),
      ...data.versions.map(v => h('span', { class: 'badge ' + (v.in_force ? 'green' : '') },
        `${fmt.date(v.effective_from)}${v.in_force ? ' (in force)' : ''}`,
        App.can('edit') ? h('button', {
          class: 'x', style: 'font-size:14px;padding:0 3px', title: 'Remove this pattern',
          onclick: () => UI.confirm(
            `Remove the weekly pattern starting ${fmt.date(v.effective_from)}? Journeys from that date will follow whichever earlier pattern applies, or the standard week.`,
            async () => {
              try { await api.del(`/api/contracts/${contract.id}/schedule/${v.id}`); toast('Weekly pattern removed', 'ok'); dlg.close(); reload(); }
              catch (e) { toast(e.message, 'err'); }
            }),
        }, '×') : null)))
    : null;

  const dlg = UI.modal({
    title: `Weekly schedule — ${contract.code}`,
    width: 'wide',
    body: h('div', null,
      h('div', { class: 'note-box', style: 'margin-bottom:12px' },
        h('strong', 'Set out a normal week once and the calendar does the rest.'),
        h('div', { style: 'margin-top:4px' },
          'Give each day the journeys it really runs. A Friday with an extra collection gets three journeys, and everyone is paid for all three.')),
      h('div', { class: 'sd-line', style: 'margin-bottom:12px' },
        h('div', { class: 'sd-field' }, h('label', 'These journeys start from *'), fromInput,
          h('div', { class: 'help' }, 'Days before this date keep the pattern they already had, so past journeys and wages never change.')),
        h('div', { class: 'sd-field grow' }, h('label', 'Name this pattern'), noteInput)),
      versionsBox,
      daysWrap),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn],
  });

  saveBtn.onclick = async () => {
    const from = fromInput.value;
    if (!from) { fromInput.focus(); return toast('Choose the date this pattern starts from', 'err'); }
    const days = DAY_ORDER.map(wd => ({ weekday: wd, trips: model[wd] }));
    if (!days.some(d => d.trips.length)) return toast('Add at least one journey, or remove the pattern to go back to the standard week', 'err');
    for (const d of days) {
      for (const t of d.trips) if (!String(t.label || '').trim()) return toast(`Every journey needs a name — check ${DAY_NAMES[d.weekday]}`, 'err');
    }
    const save = async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await api.put(`/api/contracts/${contract.id}/schedule`, { effective_from: from, note: noteInput.value || null, days });
        toast('Weekly schedule saved — the calendar now generates these journeys', 'ok');
        dlg.close();
        reload();
      } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = 'Save weekly schedule'; }
    };
    if (from < D.today()) {
      UI.confirm(
        `${fmt.date(from)} is in the past. Journeys already recorded on or after that date will be worked out again from this pattern, which can change wages that have not been paid yet. Continue?`,
        save, { yes: 'Save anyway', danger: false });
    } else await save();
  };
};

/* =========================================================
   CHILD — WEEKLY TIMETABLE
   ========================================================= */

Sched.timetablePanel = function (child, tt, reload) {
  const rows = h('div', { class: 'weekgrid' });
  for (const d of tt.days) {
    rows.appendChild(h('div', { class: 'weekrow' + (d.attends ? '' : ' none') },
      h('div', { class: 'wd' }, DAY_SHORT[d.weekday]),
      h('div', { class: 'wn' }, d.attends ? `${fmt.time(d.start_time)} – ${fmt.time(d.finish_time)}` : 'Does Not Attend'),
      h('div', { class: 'wt' }, d.attends ? '' : h('em', 'Normal day off — not an absence'))));
  }
  const mode = tt.same_all_week ? 'Same times all week' : 'Different times by day';
  const explain = !tt.configured
    ? 'No timetable set. This child travels whenever their contract runs.'
    : tt.starts_on
      ? `${mode}, starting on ${fmt.date(tt.starts_on)}.`
      : `${mode}, in force from ${fmt.date(tt.effective_from)}.`;

  return UI.card('Weekly timetable',
    h('div', null,
      h('div', { class: 'note-box' + (tt.starts_on ? ' warn' : ''), style: 'margin-bottom:10px' },
        explain, ' ', plural(tt.attending_days, 'day'), ' a week.',
        tt.note ? h('div', { style: 'margin-top:4px;color:var(--text-dim)' }, tt.note) : null,
        tt.upcoming ? h('div', { style: 'margin-top:4px' }, `A new timetable takes over on ${fmt.date(tt.upcoming.effective_from)}.`) : null),
      rows,
      h('div', { style: 'margin-top:10px;font-size:12px;color:var(--text-faint)' },
        'A day marked Does Not Attend is a normal day off. It never counts as an absence, and it does not stop the contract running for the other children.')),
    App.can('edit') ? h('button', { class: 'btn sm primary', onclick: () => Sched.timetableEditor(child, reload) }, tt.configured ? 'Edit timetable' : 'Set up timetable') : null);
};

/**
 * `preset` lets the day dialog open this straight from an absence, with the
 * date and weekday already filled in.
 */
Sched.timetableEditor = async function (child, reload, preset) {
  const loading = UI.modal({ title: 'Loading the timetable…', body: h('div', { class: 'loading' }, h('span', { class: 'spinner' })) });
  let data;
  try { data = await api.get(`/api/children/${child.id}/timetable`); }
  catch (e) { loading.close(); return toast(e.message, 'err'); }
  loading.close();

  const inForce = data.versions.find(v => v.in_force) || data.versions[0] || null;
  const model = {
    same_all_week: inForce ? inForce.same_all_week : true,
    start_time: (inForce ? inForce.start_time : null) || child.pickup_time || '',
    finish_time: (inForce ? inForce.finish_time : null) || child.finish_time || '',
    days: {},
  };
  for (const d of data.summary.days) {
    model.days[d.weekday] = {
      attends: inForce ? true : !!d.attends,
      start_time: d.start_time || '',
      finish_time: d.finish_time || '',
    };
  }
  if (inForce) for (const d of inForce.days) model.days[d.weekday] = { attends: d.attends, start_time: d.start_time || '', finish_time: d.finish_time || '' };
  for (const wd of DAY_ORDER) model.days[wd] ||= { attends: [1, 2, 3, 4, 5].includes(wd), start_time: '', finish_time: '' };
  if (preset && preset.weekday !== undefined) model.days[preset.weekday].attends = false;

  const fromInput = h('input', { type: 'date', value: preset && preset.date ? preset.date : (inForce ? inForce.effective_from : D.today()) });
  const noteInput = h('input', { type: 'text', value: inForce ? (inForce.note || '') : '', placeholder: 'e.g. College timetable, autumn term' });

  const sameRadio = h('input', { type: 'radio', name: 'ttmode', checked: !!model.same_all_week });
  const diffRadio = h('input', { type: 'radio', name: 'ttmode', checked: !model.same_all_week });
  const sameBox = h('div', { class: 'sd-line' });
  const daysWrap = h('div');

  const startInput = h('input', { type: 'time', value: model.start_time || '', oninput: e => { model.start_time = e.target.value; } });
  const finishInput = h('input', { type: 'time', value: model.finish_time || '', oninput: e => { model.finish_time = e.target.value; } });
  sameBox.appendChild(h('div', { class: 'sd-field' }, h('label', 'Starts (school or college start)'), startInput));
  sameBox.appendChild(h('div', { class: 'sd-field' }, h('label', 'Finishes'), finishInput));

  function draw() {
    sameBox.hidden = !model.same_all_week;
    daysWrap.innerHTML = '';
    daysWrap.appendChild(h('div', { class: 'help', style: 'margin:6px 0 8px' },
      model.same_all_week
        ? 'Tick the days this child travels. Untick a day they never attend, such as a college day at home.'
        : 'Give each day its own start and finish, or mark it Does Not Attend.'));
    for (const wd of DAY_ORDER) {
      const d = model.days[wd];
      const attends = h('input', { type: 'checkbox', checked: !!d.attends });
      attends.onchange = e => { d.attends = e.target.checked; draw(); };
      const row = h('div', { class: 'tt-row' + (d.attends ? '' : ' off') },
        h('label', { class: 'tt-day' }, attends, h('span', DAY_NAMES[wd])),
        d.attends
          ? (model.same_all_week
            ? h('span', { class: 'tt-times' }, `${fmt.time(model.start_time) || '—'} – ${fmt.time(model.finish_time) || '—'}`)
            : h('span', { class: 'tt-times' },
              h('input', { type: 'time', value: d.start_time || '', oninput: e => { d.start_time = e.target.value; } }),
              h('span', ' – '),
              h('input', { type: 'time', value: d.finish_time || '', oninput: e => { d.finish_time = e.target.value; } })))
          : h('span', { class: 'tt-off' }, 'DOES NOT ATTEND'));
      daysWrap.appendChild(row);
    }
  }
  sameRadio.onchange = () => { model.same_all_week = true; draw(); };
  diffRadio.onchange = () => { model.same_all_week = false; draw(); };
  startInput.addEventListener('input', draw);
  finishInput.addEventListener('input', draw);
  draw();

  const saveBtn = h('button', { class: 'btn primary' }, 'Save timetable');
  const versionsBox = data.versions.length
    ? h('div', { class: 'sd-versions' },
      h('strong', 'Saved timetables: '),
      ...data.versions.map(v => h('span', { class: 'badge ' + (v.in_force ? 'green' : '') },
        `${fmt.date(v.effective_from)}${v.in_force ? ' (in force)' : ''}`,
        App.can('edit') ? h('button', {
          class: 'x', style: 'font-size:14px;padding:0 3px', title: 'Remove this timetable',
          onclick: () => UI.confirm(
            `Remove the timetable starting ${fmt.date(v.effective_from)}? Days from that date will follow whichever earlier timetable applies, or the contract's own days.`,
            async () => {
              try { await api.del(`/api/children/${child.id}/timetable/${v.id}`); toast('Timetable removed', 'ok'); dlg.close(); reload(); }
              catch (e) { toast(e.message, 'err'); }
            }),
        }, '×') : null)))
    : null;

  const dlg = UI.modal({
    title: `Weekly timetable — ${fmt.name(child)}`,
    width: 'wide',
    body: h('div', null,
      h('div', { class: 'note-box', style: 'margin-bottom:12px' },
        h('strong', 'When does this child normally travel?'),
        h('div', { style: 'margin-top:4px' },
          'A day marked Does Not Attend is a normal day off, not an absence, and the contract still runs for everyone else.')),
      h('div', { class: 'sd-line', style: 'margin-bottom:12px' },
        h('div', { class: 'sd-field' }, h('label', 'This timetable starts from *'), fromInput,
          h('div', { class: 'help' }, 'Earlier days keep the timetable they already had.')),
        h('div', { class: 'sd-field grow' }, h('label', 'Name this timetable'), noteInput)),
      versionsBox,
      h('div', { class: 'tt-modes' },
        h('label', sameRadio, h('span', h('strong', 'Same all week'), ' — one start and finish time')),
        h('label', diffRadio, h('span', h('strong', 'Different times by day'), ' — for college or part-time weeks'))),
      sameBox,
      daysWrap),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn],
  });

  saveBtn.onclick = async () => {
    const from = fromInput.value;
    if (!from) { fromInput.focus(); return toast('Choose the date this timetable starts from', 'err'); }
    if (model.same_all_week && !model.start_time && !model.finish_time) return toast('Enter the start and finish times', 'err');
    const days = DAY_ORDER.map(wd => ({
      weekday: wd,
      attends: model.days[wd].attends ? 1 : 0,
      start_time: model.same_all_week ? null : (model.days[wd].start_time || null),
      finish_time: model.same_all_week ? null : (model.days[wd].finish_time || null),
    }));
    if (!days.some(d => d.attends)) return toast('Tick at least one day this child travels', 'err');

    const save = async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await api.put(`/api/children/${child.id}/timetable`, {
          effective_from: from, same_all_week: model.same_all_week ? 1 : 0,
          start_time: model.start_time || null, finish_time: model.finish_time || null,
          note: noteInput.value || null, days,
        });
        toast('Timetable saved', 'ok');
        dlg.close();
        reload();
      } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = 'Save timetable'; }
    };
    if (from < D.today()) {
      UI.confirm(
        `${fmt.date(from)} is in the past. Days already recorded on or after that date will be worked out again from this timetable. Continue?`,
        save, { yes: 'Save anyway', danger: false });
    } else await save();
  };
};

/* =========================================================
   ONE-OFF OR PERMANENT?
   The question that keeps a day's fix from quietly becoming the new normal.
   ========================================================= */

/**
 * Asks whether a change applies to one date or to every week, then hands back
 * to the caller. `opts.onceLabel` / `opts.onceDo` describe the one-off, and
 * `opts.alwaysLabel` / `opts.alwaysDo` the recurring change.
 */
Sched.scopeDialog = function ({ title, intro, onceLabel, onceHint, onceDo, alwaysLabel, alwaysHint, alwaysDo }) {
  const dlg = UI.modal({
    title, width: 'narrow',
    body: h('div', null,
      intro ? h('p', { style: 'margin:0 0 12px' }, intro) : null,
      h('div', { class: 'scope-choices' },
        h('button', {
          class: 'scope', onclick: async () => { dlg.close(); await onceDo(); },
        }, h('strong', onceLabel), h('span', onceHint)),
        h('button', {
          class: 'scope', onclick: async () => { dlg.close(); await alwaysDo(); },
        }, h('strong', alwaysLabel), h('span', alwaysHint)))),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel')],
  });
  return dlg;
};
