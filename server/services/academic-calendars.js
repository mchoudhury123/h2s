'use strict';
const db = require('../db');
const data = require('../data/academic-2026-27');
const crypto = require('node:crypto');
const now = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const normal = s => s.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/school$/,'');
// Rows typed into the CRM outrank imported rows on the same date: the newest
// confirmed open or closed entry wins, so an edit always takes effect.
const MANUAL='Entered in the CRM', OVERRIDE_NOTES=['Administrator override',MANUAL];
const validDate=d=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d;
const yearBounds=year=>({start:year.slice(0,4)+'-09-01',end:(Number(year.slice(0,4))+1)+'-08-31'});
const validYear=year=>typeof year==='string' && /^20\d{2}\/\d{2}$/.test(year) && Number(year.slice(-2))===(Number(year.slice(0,4))+1)%100;
async function audit(tx, org, user, id, action, summary) {
  await db.insert('audit_log',{user_name:user.name,entity_type:'school_calendar',entity_id:id,action,summary},['user_name','entity_type','entity_id','action','summary'],tx,org);
}
async function requireState(tx,org,id,state) {
  const row=await tx.get('SELECT state FROM school_calendar_versions WHERE organisation_id = ? AND id = ?'+(db.dialect==='postgres'?' FOR UPDATE':''),[org,Number(id)]);
  if (!row || row.state!==state) throw new Error('Calendar state changed; refresh the dashboard.');
}
function validateImport(input) {
  if (!input || !/^20\d{2}\/\d{2}$/.test(input.academic_year) || Number(input.academic_year.slice(-2)) !== (Number(input.academic_year.slice(0,4))+1)%100)
    throw new Error('Specify an academic year such as 2027/28.');
  if (!input.import_key || String(input.import_key).length>120 || !Array.isArray(input.schools) || !input.schools.length || input.schools.length>200) throw new Error('Specify an import key and 1–200 schools.');
  const start=input.academic_year.slice(0,4)+'-09-01', end=(Number(input.academic_year.slice(0,4))+1)+'-08-31';
  const seen=new Set();
  for (const school of input.schools) {
    if (!school.name || String(school.name).length>200 || seen.has(normal(school.name)) || !Array.isArray(school.records) || school.records.length>1000) throw new Error('School names must be unique and each school must have at most 1000 date records.');
    seen.add(normal(school.name));
    for (const r of school.records) {
      const valid=d=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d;
      if (!valid(r.date_from)||!valid(r.date_to)||r.date_from>r.date_to||r.date_from<start||r.date_to>end || !['closed','open','term'].includes(r.record_type) || !['confirmed','provisional'].includes(r.verification_status) || !String(r.reason||'').trim()) throw new Error('Invalid calendar record for '+school.name+'. Check academic year, dates, type, reason and verification.');
      if (r.source_url && !/^https?:\/\//i.test(r.source_url)) throw new Error('Source URL must use http or https.');
    }
  }
}
async function stageImport(org,user,input) {
  validateImport(input);
  return db.transaction(async tx => {
    const schools = await tx.all('SELECT * FROM schools WHERE organisation_id = ?', [org]);
    for (const school of input.schools) {
      const matches = schools.filter(s => normal(s.name) === normal(school.name));
      if (matches.length > 1) throw new Error('Ambiguous school match: '+school.name+'. Resolve duplicate schools before importing.');
      const school_id = matches[0]?.id || await db.insert('schools',{name:school.name},['name'],tx,org);
      if (await tx.get('SELECT id FROM school_calendar_versions WHERE organisation_id = ? AND school_id = ? AND import_key = ?', [org,school_id,input.import_key])) continue;
      const records = school.records;
      const verification_status = school.verification_status || (records.length && records.every(r=>r.verification_status==='confirmed') ? 'verified' : records.some(r=>r.verification_status==='confirmed') ? 'partially_verified' : 'unconfirmed');
      if (!['verified','partially_verified','unconfirmed'].includes(verification_status)) throw new Error('Invalid school verification status');
      const version = {school_id,academic_year:input.academic_year,import_key:input.import_key,verification_status,note:school.note || ''};
      const id = await db.insert('school_calendar_versions',version,Object.keys(version),tx,org);
      for (const r of records) {
        const row = {version_id:id,school_id,date_from:r.date_from,date_to:r.date_to,reason:r.reason,verification_status:r.verification_status,record_type:r.record_type,source_url:r.source_url || null,source_note:r.source_note || 'Administrator import'};
        await db.insert('school_calendar_records',row,Object.keys(row),tx,org);
      }
      await audit(tx,org,user,id,'import','Staged '+input.academic_year+' calendar for '+school.name+'; no operational or financial changes.');
    }
    return {ok:true};
  });
}
async function prepare(org,user) {
  return stageImport(org,user,{academic_year:data.year,import_key:data.key,schools:data.names.map(name=>({name,records:data.records(name),note:data.note(name),verification_status:data.sessions[name]?'verified':data.records(name).some(r=>r.verification_status==='confirmed')?'partially_verified':'unconfirmed'}))});
}
async function list(org) {
  const versions = await db.all(`SELECT v.*, s.name AS school_name FROM school_calendar_versions v JOIN schools s ON s.id = v.school_id AND s.organisation_id = v.organisation_id WHERE v.organisation_id = ? ORDER BY s.name,v.id DESC`,[org]);
  const records = await db.all('SELECT * FROM school_calendar_records WHERE organisation_id = ? ORDER BY date_from,id',[org]);
  return versions.map(v=>({...v,records:records.filter(r=>r.version_id===v.id)}));
}
async function version(org,id) {
  const v = (await list(org)).find(v=>v.id===Number(id));
  if (!v) throw new Error('School calendar not found');
  return v;
}
function expand(v,from,to,force=false) {
  const cal = require('./calendar');
  const out=[];
  for (const date of cal.dateRange(from,to)) {
    const year=Number(v.academic_year.slice(0,4));
    if (date<year+'-09-01' || date>(year+1)+'-08-31') continue;
    if (!force && v.reverted_from && date>=v.reverted_from) continue;
    const active = force || (v.effective_from && date>=v.effective_from && (!v.reverted_from || date<v.reverted_from));
    const records=v.records.filter(r=>r.date_from<=date && r.date_to>=date && r.record_type!=='withdrawn');
    const override = records.filter(r=>r.verification_status==='confirmed' && OVERRIDE_NOTES.includes(r.source_note) && ['open','closed'].includes(r.record_type)).sort((a,b)=>a.id-b.id).at(-1);
    const weekend = [0,6].includes(cal.dow(date)) ? {reason:'Weekend',verification_status:'confirmed',id:'weekend'} : null;
    const closed = override ? (override.record_type==='closed' ? override : null) : records.find(r=>r.record_type==='closed' && r.verification_status==='confirmed') || weekend;
    const opened = override?.record_type==='open' || records.some(r=>r.record_type==='open' && r.verification_status==='confirmed');
    const provisional = !closed && !opened && records.find(r=>r.record_type==='closed' && r.verification_status==='provisional');
    const r = closed || provisional;
    if (!r) continue;
    out.push({id:`academic-${v.id}-${r.id}-${date}`,academic_version_id:v.id,school_id:v.school_id,contract_id:null,date,leg:'DAY',trip_seq:null,
      type: active && closed ? 'school_closed' : 'school_provisional',note: (active && closed ? 'SCHOOL CLOSED: ' : 'PROVISIONAL / awaiting approval: ')+r.reason,verification_status:r.verification_status});
  }
  return out;
}
async function exceptions(org,from,to) { return (await list(org)).flatMap(v=>expand(v,from,to)); }
function impact(ctx,baseline,proposed,v,from,to,operation) {
  const cal=require('./calendar');
  const result={school_id:v.school_id,school_name:v.school_name,operation,from,to,children:[],contracts:[],trips:0,driver_wages:0,pa_wages:0,expected_invoice_effect:0,invoice_days_effect:0,details:[],
    warning:'Future dates only. Issued invoices, payroll and payments remain unchanged. Provisional dates have no automatic financial effect. Invoice effects use existing contract chargeability rules.'};
  const childIds=new Set(), contractIds=new Set();
  for (const c of ctx.contracts) for (const date of cal.dateRange(from,to)) {
    const children=ctx.childMap[c.id]||[];
    const a=cal.evaluateContractDay(c,date,children,baseline,ctx), b=cal.evaluateContractDay(c,date,children,proposed,ctx);
    const wages = (day,role) => day.trips.reduce((n,t)=>n+(t[role]?.pay||0),0) + day.exceptions.filter(e=>e.type==='staff_absence' && e.role===role && e.cover_staff_id).reduce((n,e)=>n+cal.coverAmount(day,e),0);
    const delta = role => cal.round2(wages(b,role)-wages(a,role));
    const changed=b.trips.filter((t,i)=>t.closed!==a.trips[i]?.closed || JSON.stringify(t.children)!==JSON.stringify(a.trips[i]?.children));
    if (!changed.length) continue;
    contractIds.add(c.id);
    for (const ch of children) if ((v.school_ids || [v.school_id]).includes(ch.school_id||c.school_id)) childIds.add(ch.id);
    const row={date,contract_id:c.id,contract_code:c.code,trips:changed.length,driver_wages:delta('driver'),pa_wages:delta('pa'),invoice_effect:cal.round2(b.income-a.income),invoice_days_effect:b.chargeable_days-a.chargeable_days};
    result.details.push(row); result.trips+=row.trips; result.driver_wages+=row.driver_wages;result.pa_wages+=row.pa_wages;result.expected_invoice_effect+=row.invoice_effect;result.invoice_days_effect+=row.invoice_days_effect;
  }
  result.children=[...childIds]; result.child_details=Object.values(ctx.childMap).flat().filter(ch=>childIds.has(ch.id)).map(ch=>({id:ch.id,name:ch.name,school_id:ch.school_id})); result.contracts=ctx.contracts.filter(c=>contractIds.has(c.id)).map(c=>({id:c.id,code:c.code}));
  for (const k of ['driver_wages','pa_wages','expected_invoice_effect','invoice_days_effect']) result[k]=cal.round2(result[k]);
  return result;
}
async function preview(org,id,operation='approve') {
  const v=await version(org,id);
  if (!['approve','revert'].includes(operation)) throw new Error('Invalid calendar operation');
  if (operation==='approve' && v.state!=='draft') throw new Error('Only draft calendars can be approved');
  if (operation==='revert' && v.state!=='approved') throw new Error('Only approved calendars can be reversed');
  const cal=require('./calendar');
  const from=[cal.addDays(today(),1),v.academic_year.slice(0,4)+'-09-01'].sort().at(-1), to=`${Number(v.academic_year.slice(0,4))+1}-08-31`;
  if (from>to) throw new Error('This academic year has ended; historical calendars cannot be applied automatically.');
  if (operation==='approve' && (await list(org)).some(other=>other.id!==v.id && other.school_id===v.school_id && other.academic_year===v.academic_year && other.state==='approved')) throw new Error('Reverse the currently approved calendar for this school before approving a replacement.');
  const ctx=await cal.loadContext(org,from,to);
  const baseline=ctx.exceptions;
  const without=baseline.filter(e=>e.academic_version_id!==v.id);
  const proposed=operation==='revert' ? without : [...without,...expand(v,from,to,true)];
  const result=impact(ctx,baseline,proposed,v,from,to,operation);
  result.token=crypto.createHash('sha256').update(JSON.stringify({v,ctx:{...ctx,schedules:[...ctx.schedules],timetables:[...ctx.timetables]},result})).digest('hex');
  return result;
}
async function bulkPreview(org,ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length>200) throw new Error('Choose draft calendars to preview.');
  const versions=await list(org), selected=[...new Set(ids.map(Number))].map(id=>versions.find(v=>v.id===id));
  if (selected.some(v=>!v || v.state!=='draft')) throw new Error('Only this organisation’s draft calendars can be previewed.');
  const cal=require('./calendar');
  const from=cal.addDays(today(),1), to=selected.map(v=>(Number(v.academic_year.slice(0,4))+1)+'-08-31').sort().at(-1);
  if (from>to) throw new Error('These academic years have ended.');
  const ctx=await cal.loadContext(org,from,to), baseline=ctx.exceptions;
  const proposed=[...baseline.filter(e=>!selected.some(v=>v.id===e.academic_version_id)),...selected.flatMap(v=>expand(v,from,to,true))];
  const result=impact(ctx,baseline,proposed,{school_ids:selected.map(v=>v.school_id)},from,to,'bulk_projection');
  return {...result,school_names:selected.map(v=>v.school_name)};
}
async function apply(org,user,id,body) {
  return db.transaction(async tx=>{
    // Serialise approvals and lock draft edits while rechecking the reviewed projection.
    if (db.dialect==='postgres') await tx.get('SELECT id FROM organisations WHERE id = ? FOR UPDATE',[org]);
    await requireState(tx,org,id,body.operation==='revert'?'approved':'draft');
    const p=await preview(org,id,body.operation);
    if (body.token!==p.token) throw new Error('Calendar or transport data changed. Refresh the impact preview before approval.');
    const state=body.operation==='revert'?'reverted':'approved';
    const res=await tx.run(`UPDATE school_calendar_versions SET state = ?, effective_from = COALESCE(effective_from, ?), reverted_from = ?, approved_by = ?, approved_at = ? WHERE organisation_id = ? AND id = ? AND state = ?`,[state,p.from,state==='reverted'?p.from:null,user.name,now(),org,Number(id),state==='reverted'?'approved':'draft']);
    if (!res.changes) throw new Error('Calendar state changed; refresh the dashboard.');
    await audit(tx,org,user,Number(id),state,JSON.stringify(p));
    return {ok:true,state};
  });
}
async function revise(org,user,id) {
  const v=await version(org,id);
  if(v.state==='draft') return {id:v.id};
  // Revert first so a second approved version cannot create conflicting closures.
  if(v.state==='approved') throw new Error('Preview and reverse this calendar before creating an amended draft.');
  return db.transaction(async tx=>{
    const fields={school_id:v.school_id,academic_year:v.academic_year,import_key:crypto.randomUUID(),verification_status:v.verification_status,note:v.note};
    const next=await db.insert('school_calendar_versions',fields,Object.keys(fields),tx,org);
    for(const r of v.records) { const {id,created_at,organisation_id,...row}=r;row.version_id=next;await db.insert('school_calendar_records',row,Object.keys(row),tx,org); }
    await audit(tx,org,user,next,'revision','Created amended draft from calendar '+id);return {id:next};
  });
}
async function addRecord(org,user,id,body) {
  const v=await version(org,id);
  if(v.state!=='draft') throw new Error('Only draft calendars can be edited. Reverse and create an amended draft first.');
  const valid=d=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d;
  const start=v.academic_year.slice(0,4)+'-09-01',end=(Number(v.academic_year.slice(0,4))+1)+'-08-31';
  if(!valid(body.date_from)||!valid(body.date_to)||body.date_from>body.date_to||body.date_from<start||body.date_to>end) throw new Error('Enter inclusive dates within this academic year.');
  if(!['confirmed','provisional'].includes(body.verification_status)||!['open','closed','term'].includes(body.record_type)||!String(body.reason||'').trim()) throw new Error('Specify a reason, verification status and record type.');
  if(body.source_url && !/^https?:\/\//i.test(body.source_url)) throw new Error('Source URL must use http or https.');
  return db.transaction(async tx=>{
    await requireState(tx,org,v.id,'draft');
    const row={school_id:v.school_id,version_id:v.id,date_from:body.date_from,date_to:body.date_to,reason:String(body.reason).slice(0,500),verification_status:body.verification_status,record_type:body.record_type,source_url:body.source_url||null,source_note:'Administrator override'};
    await db.insert('school_calendar_records',row,Object.keys(row),tx,org);
    await tx.run("UPDATE school_calendar_versions SET verification_status = 'partially_verified' WHERE organisation_id = ? AND id = ?",[org,v.id]);
    await audit(tx,org,user,v.id,'amend',JSON.stringify(row));return {ok:true};
  });
}
async function verifyRecord(org,user,id,body) {
  const v=await version(org,id);
  if (v.state!=='draft') throw new Error('Only draft calendars can be verified; create an amended draft first.');
  const record=v.records.find(r=>r.id===Number(body.record_id));
  if (!record) throw new Error('Calendar record not found');
  if (body.source_url && !/^https?:\/\//i.test(body.source_url)) throw new Error('Source URL must use http or https.');
  return db.transaction(async tx=>{
    await requireState(tx,org,v.id,'draft');
    await tx.run("UPDATE school_calendar_records SET verification_status = 'confirmed', source_url = ? WHERE organisation_id = ? AND version_id = ? AND id = ?",[body.source_url||record.source_url||null,org,v.id,record.id]);
    const status=v.records.every(r=>r.id===record.id || r.verification_status==='confirmed')?'verified':'partially_verified';
    await tx.run('UPDATE school_calendar_versions SET verification_status = ? WHERE organisation_id = ? AND id = ?',[status,org,v.id]);
    await audit(tx,org,user,v.id,'verify',JSON.stringify({before:record,verification_status:'confirmed',source_url:body.source_url||record.source_url||null}));
    return {ok:true};
  });
}
// Term dates typed straight into the CRM. A school with no calendar for the
// year gets a live one at once; there is nothing to preview because it starts
// empty, and every date added afterwards is saved through saveRecords.
async function create(org,user,body) {
  const year=String(body?.academic_year||'');
  if (!validYear(year)) throw new Error('Specify an academic year such as 2027/28.');
  const school=await db.get('SELECT id, name FROM schools WHERE organisation_id = ? AND id = ?',[org,Number(body.school_id)]);
  if (!school) throw new Error('School not found');
  const existing=(await list(org)).filter(v=>v.school_id===school.id && v.academic_year===year && v.state!=='reverted').sort((a,b)=>b.id-a.id)[0];
  if (existing) return {id:existing.id, created:false};
  const effective_from=[yearBounds(year).start,today()].sort().at(-1);
  return db.transaction(async tx=>{
    const fields={school_id:school.id,academic_year:year,import_key:'manual-'+year.replace('/','-')+'-'+crypto.randomUUID(),verification_status:'unconfirmed',note:'Term dates entered in the CRM.',state:'approved',effective_from,approved_by:user.name,approved_at:now()};
    const id=await db.insert('school_calendar_versions',fields,Object.keys(fields),tx,org);
    await audit(tx,org,user,id,'created','Started '+year+' term dates for '+school.name+' (live from '+effective_from+').');
    return {id, created:true};
  });
}
// The whole list of dates for one school and year, as the editor shows it:
// rows with an id are kept or changed, rows without one are new, and any row
// the list no longer carries is removed. Works on draft and live calendars.
async function saveRecords(org,user,id,body) {
  const v=await version(org,id);
  if (v.state==='reverted') throw new Error('This calendar was reversed. Create an amended draft first.');
  const incoming=Array.isArray(body?.records)?body.records:null;
  if (!incoming || incoming.length>1000) throw new Error('Send the list of term dates (up to 1000 rows).');
  const {start,end}=yearBounds(v.academic_year);
  const rows=incoming.map((r,i)=>{
    const row={id:r.id==null||r.id===''?null:Number(r.id),date_from:r.date_from,date_to:r.date_to,reason:String(r.reason||'').trim().slice(0,500),
      record_type:r.record_type||'closed',verification_status:r.verification_status||'confirmed',source_url:r.source_url?String(r.source_url):null};
    const where=`Row ${i+1}${row.reason?' ('+row.reason+')':''}: `;
    if (row.id!==null && !Number.isInteger(row.id)) throw new Error(where+'unknown record.');
    if (!validDate(row.date_from)||!validDate(row.date_to)) throw new Error(where+'enter a first and last date.');
    if (row.date_from>row.date_to) throw new Error(where+'the last date is before the first date.');
    if (row.date_from<start||row.date_to>end) throw new Error(where+'dates must fall inside the '+v.academic_year+' academic year ('+start+' to '+end+').');
    if (!['open','closed','term'].includes(row.record_type)||!['confirmed','provisional'].includes(row.verification_status)) throw new Error(where+'choose Closed, Open or Term window, and whether the dates are confirmed.');
    if (!row.reason) throw new Error(where+'give the dates a name, such as October half term or INSET day.');
    if (row.source_url && !/^https?:\/\//i.test(row.source_url)) throw new Error(where+'the source URL must use http or https.');
    return row;
  });
  const FIELDS=['date_from','date_to','reason','record_type','verification_status','source_url'];
  const changes={added:[],changed:[],removed:[]};
  await db.transaction(async tx=>{
    await requireState(tx,org,v.id,v.state);
    const keep=new Set();
    for (const row of rows) {
      if (row.id===null) {
        const data={school_id:v.school_id,version_id:v.id,...Object.fromEntries(FIELDS.map(f=>[f,row[f]])),source_note:MANUAL};
        row.id=await db.insert('school_calendar_records',data,Object.keys(data),tx,org);
        changes.added.push(row); keep.add(row.id); continue;
      }
      const before=v.records.find(r=>r.id===row.id);
      if (!before) throw new Error('Calendar record not found');
      keep.add(row.id);
      if (FIELDS.every(f=>(before[f]||null)===(row[f]||null))) continue;
      await tx.run(`UPDATE school_calendar_records SET date_from = ?, date_to = ?, reason = ?, record_type = ?, verification_status = ?, source_url = ?, source_note = COALESCE(source_note, ?) WHERE organisation_id = ? AND version_id = ? AND id = ?`,
        [...FIELDS.map(f=>row[f]),MANUAL,org,v.id,row.id]);
      changes.changed.push({before,after:row});
    }
    for (const r of v.records) if (!keep.has(r.id)) {
      await tx.run('DELETE FROM school_calendar_records WHERE organisation_id = ? AND version_id = ? AND id = ?',[org,v.id,r.id]);
      changes.removed.push(r);
    }
    const confirmed=rows.filter(r=>r.verification_status==='confirmed').length;
    const status=rows.length && confirmed===rows.length?'verified':confirmed?'partially_verified':'unconfirmed';
    await tx.run('UPDATE school_calendar_versions SET verification_status = ? WHERE organisation_id = ? AND id = ?',[status,org,v.id]);
    const words=[changes.added.length+' added',changes.changed.length+' changed',changes.removed.length+' removed'].join(', ');
    await audit(tx,org,user,v.id,'term_dates',`${v.school_name} ${v.academic_year}: ${words}; ${confirmed} of ${rows.length} confirmed. `+JSON.stringify(changes));
  });
  const warnings=[];
  const touched=[...changes.added,...changes.changed.map(c=>c.after),...changes.removed].filter(r=>r.record_type!=='term');
  if (v.state==='approved' && v.effective_from && touched.some(r=>r.date_from<v.effective_from))
    warnings.push(`Dates before ${v.effective_from.split('-').reverse().join('/')} are kept as they were, so wages and invoices already worked out for those days do not change.`);
  if (v.state==='approved' && v.effective_from && touched.some(r=>r.date_from<today() && r.date_to>=v.effective_from))
    warnings.push('Some of these dates have already passed. Wages and invoice previews for those days are recalculated; issued invoices and recorded payments are not changed and need separate review.');
  if (v.state==='draft') warnings.push('This calendar is still a draft, so the dates do not reach the operations calendar until it is previewed and approved.');
  return {ok:true,version:await version(org,v.id),changes:{added:changes.added.length,changed:changes.changed.length,removed:changes.removed.length},warnings};
}
module.exports={bulkPreview,verifyRecord,stageImport,prepare,list,exceptions,expand,preview,apply,addRecord,revise,create,saveRecords,MANUAL};
