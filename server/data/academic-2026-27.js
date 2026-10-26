'use strict';
// Supplied by Tyne & Wear Cars Ltd. No source URLs were supplied; do not invent them.
const holidays = [
  ['2026-10-26','2026-10-30','October half term'],
  ['2026-12-21','2027-01-01','Christmas'],
  ['2027-02-15','2027-02-19','February half term'],
  ['2027-03-26','2027-04-09','Easter'],
  ['2027-05-03','2027-05-03','May Day'],
  ['2027-05-31','2027-06-04','May half term'],
];
const terms = [['2026-09-01','2026-12-18'],['2027-01-04','2027-03-25'],['2027-04-12','2027-07-16']];
const names = ['Ashley Primary School','Bamburgh School','Bede Community Primary School','Benton House School','East Boldon Juniors','Epinay School','ESPA Tasker College','ESPA South Hill','Fellgate Primary School','Furrowfield School','Percy Hedley College','Mortimer Community College','NEAS Emsworth','NEAS Thornhill Park',"St Mary's RC Primary School",'The Beacon Centre Secondary School','Tyne Met College','West Boldon Primary School','Westoe Crown Primary School'];
const inset = {
  'Bede Community Primary School': ['2026-09-01','2027-01-04','2027-07-16'],
  'East Boldon Juniors': ['2026-09-01'], 'Epinay School': ['2026-09-01','2027-03-25'],
  'Fellgate Primary School': ['2026-11-06','2027-03-05'],
};
const sessions = {
  'Percy Hedley College': [['2026-09-03','2026-10-23'],['2026-11-02','2026-12-18'],['2027-01-04','2027-02-12'],['2027-02-23','2027-03-25'],['2027-04-12','2027-05-27'],['2027-06-07','2027-07-20']],
  'Tyne Met College': [['2026-09-01','2026-10-23'],['2026-11-02','2026-12-17'],['2027-01-05','2027-02-12'],['2027-02-22','2027-03-25'],['2027-04-12','2027-05-28'],['2027-06-07','2027-06-25']],
};
const add = d => { const t = new Date(d+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()+1); return t.toISOString().slice(0,10); };
function records(name) {
  const result = [];
  const put = (from,to,reason,status,type='closed') => result.push({date_from:from,date_to:to,reason,verification_status:status,record_type:type,source_note:'Customer-supplied 2026/27 calendar; individual school verification as indicated.'});
  for (const [a,b] of terms) put(a,b,'Provisional term window — pupil attendance not guaranteed','provisional','term');
  for (const [a,b,label] of holidays) put(a,b,label, name === 'Mortimer Community College' ? 'confirmed' : 'provisional');
  for (const d of inset[name] || []) put(d,d,'Confirmed INSET / pupil closure','confirmed');
  if (sessions[name]) {
    // A confirmed session supersedes provisional council windows; close all other weekdays.
    for (const [a,b] of sessions[name]) put(a,b,'Confirmed college session','confirmed','open');
    for (let d='2026-09-01';d<='2027-08-31';d=add(d)) {
      if ([0,6].includes(new Date(d+'T00:00:00Z').getUTCDay())) continue;
      if (!sessions[name].some(([a,b]) => d>=a && d<=b)) put(d,d,'Outside confirmed college sessions','confirmed');
    }
    if (name === 'Tyne Met College') put('2027-05-03','2027-05-03','May Day bank holiday','confirmed');
  }
  if (name === 'Bede Community Primary School') {
    put('2027-07-15','2027-07-15','Final pupil day','confirmed','open');
    put('2027-07-16','2027-08-31','Summer closure after confirmed final pupil day','confirmed');
  }
  if (name === 'East Boldon Juniors') put('2026-09-02','2026-09-02','Pupils start','confirmed','open');
  return result;
}
module.exports = { year:'2026/27', key:'twc-2026-27-v1', names, records, sessions, inset, holidays, terms,
  note: name => name === 'Tyne Met College' ? 'College-wide periods only; confirm individual learner timetables.' : name === 'Percy Hedley College' ? 'Confirmed college sessions end 20 July 2027.' : name === 'Bede Community Primary School' ? 'Final pupil day 15 July 2027. Remaining school dates provisional.' : 'Other INSET and individual term dates require verification. North Tyneside schools may continue until 21 July 2027; no automatic closure on 16 July.' };
