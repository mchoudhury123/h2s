'use strict';
process.env.H2S_DB_DRIVER='sqlite';process.env.H2S_DB=':memory:';process.env.H2S_STRICT_TENANCY='1';
const assert=require('node:assert/strict');
const {mock}=require('node:test');mock.timers.enable({apis:['Date'],now:new Date('2026-10-23T12:00:00Z')});
const db=require('../server/db'), service=require('../server/services/academic-calendars'),cal=require('../server/services/calendar'),data=require('../server/data/academic-2026-27');
(async()=>{
 await db.migrate();await db.migrate();
 const org=await db.insert('organisations',{name:'Tyne & Wear Cars Ltd'},['name']);
 const other=await db.insert('organisations',{name:'Other'},['name']);const user={name:'Admin'};
 const add=(table,row)=>db.insert(table,row,Object.keys(row),null,org);
 await service.prepare(org,user);await service.prepare(org,user);
 let versions=await service.list(org);assert.equal(versions.length,19);assert.equal((await service.list(other)).length,0);
 assert.equal((await db.all('SELECT * FROM schools WHERE organisation_id = ?',[org])).length,19);
 const get=name=>versions.find(v=>v.school_name===name);
 assert.equal(get('Ashley Primary School').verification_status,'unconfirmed');
 assert.equal(get('Mortimer Community College').verification_status,'partially_verified');
 assert.equal(get('Percy Hedley College').verification_status,'verified');
 for(const name of data.names) assert.equal(get(name).records.filter(r=>r.record_type==='term').length,3);
 const bed=get('Bede Community Primary School'), ash=get('Ashley Primary School'),percy=get('Percy Hedley College'),tyne=get('Tyne Met College');
 const forced=(v,date)=>service.expand(v,date,date,true).filter(e=>e.type==='school_closed');
 for(const date of ['2026-09-01','2027-01-04','2027-07-16']) assert.equal(forced(bed,date).length,1);
 assert.equal(forced(percy,'2027-07-20').length,0);assert.equal(forced(percy,'2027-07-21').length,1);
 assert.equal(forced(percy,'2027-02-22').length,1);assert.equal(forced(percy,'2027-02-23').length,0);
 assert.equal(forced(tyne,'2027-05-03').length,1);assert.equal(forced(tyne,'2027-06-25').length,0);assert.equal(forced(tyne,'2027-06-28').length,1);
 assert.equal(forced(bed,'2027-07-19').length,1);assert.equal(forced(ash,'2027-07-19').length,0);assert.equal(forced(ash,'2026-10-26').length,0);
 const driver=await add('staff',{type:'driver',first_name:'D',last_name:'Driver'}),pa=await add('staff',{type:'pa',first_name:'P',last_name:'Assistant'});
 const c=await add('contracts',{code:'MIX',school_id:bed.school_id,driver_id:driver,pa_id:pa,requires_pa:1,status:'active',start_date:'2026-09-01',days_of_week:'1,2,3,4,5',income_per_day:100,driver_pay_per_day:60,pa_pay_per_day:40,income_basis:'per_journey',pay_basis:'per_journey'});
 const child1=await add('children',{first_name:'B',last_name:'Child',contract_id:c,school_id:bed.school_id}), child2=await add('children',{first_name:'A',last_name:'Child',contract_id:c,school_id:ash.school_id});
 const context=await cal.loadContext(org,'2027-01-04','2027-01-04');const contract=context.contracts[0];
 // Another school's closure keeps its child at home; the route's own school closing stops the route.
 const ashClosed=[{id:'ash-x',school_id:ash.school_id,contract_id:null,date:'2027-01-04',leg:'DAY',trip_seq:null,type:'school_closed',note:'SCHOOL CLOSED: Ashley INSET'}];
 let day=cal.evaluateContractDay(contract,'2027-01-04',context.childMap[c],ashClosed,context);
 assert.equal(day.closed_trips,0);assert.equal(day.income,100);assert.equal(day.trips[0].children.find(ch=>ch.id===child2).status,'school_closed');assert.equal(day.trips[0].children.find(ch=>ch.id===child1).status,'travelling');
 day=cal.evaluateContractDay(contract,'2027-01-04',context.childMap[c],forced(bed,'2027-01-04'),context);
 assert.equal(day.closed_trips,2);assert.equal(day.income,0);assert(day.trips.every(t=>t.driver.pay===0&&t.pa.pay===0));assert.equal(day.trips[0].children.find(ch=>ch.id===child2).status,'not_operated');
 day=cal.evaluateContractDay(contract,'2027-01-04',context.childMap[c].filter(ch=>ch.id===child2),ashClosed,context);
 assert.equal(day.closed_trips,2,'nobody left aboard once the only child is at a closed school');assert.equal(day.income,0);
 assert.equal(cal.chargeableDays([{closed:false},{closed:false},{closed:false}]),1.5);
 const splitContext={...context,schedules:new Map([[c,[{effective_from:'2026-09-01',trips:[
   {weekday:1,seq:1,label:'AM',kind:'outbound',child_ids:[child1]},
   {weekday:1,seq:2,label:'PM',kind:'return',child_ids:[child2]},
   {weekday:1,seq:3,label:'Third trip',kind:'other',child_ids:[child1]}
 ]}]]])};
 day=cal.evaluateContractDay(contract,'2027-01-04',context.childMap[c],ashClosed,splitContext);
 assert.equal(day.closed_trips,1);assert.equal(day.trips[1].school_status,'SCHOOL_CLOSED');assert.equal(day.trips[1].driver.pay,0);assert.equal(day.trips[1].pa.pay,0);assert.equal(day.trips[2].status,'operated');assert.equal(day.income,100);assert.equal(day.chargeable_days,1);
 day=cal.evaluateContractDay(contract,'2027-01-04',context.childMap[c],forced(bed,'2027-01-04'),splitContext);
 assert.equal(day.closed_trips,3);assert.equal(day.income,0);assert.equal(day.chargeable_days,0);
 assert((await cal.buildCalendar(org,'2027-01-04','2027-01-04',{school_id:ash.school_id})).rows.some(r=>r.contract.id===c));

 // Drafts cannot close trips; the preview exposes changed child participation on mixed runs.
 assert((await service.exceptions(org,'2027-01-04','2027-01-04')).every(e=>e.type!=='school_closed'));
 let p=await service.preview(org,bed.id);assert(p.children.includes(child1));assert(p.driver_wages<0,'closing the route\'s own school takes the driver pay off');assert(p.expected_invoice_effect<0);
 await assert.rejects(service.apply(org,user,bed.id,{operation:'approve',token:'stale'}),/Refresh/);
 await service.addRecord(org,user,bed.id,{date_from:'2027-01-05',date_to:'2027-01-05',reason:'Extra INSET',record_type:'closed',verification_status:'confirmed'});
 await assert.rejects(service.apply(org,user,bed.id,{operation:'approve',token:p.token}),/Refresh/);
 p=await service.preview(org,bed.id);await service.apply(org,user,bed.id,{operation:'approve',token:p.token});
 assert((await service.exceptions(org,'2027-01-04','2027-01-04')).some(e=>e.type==='school_closed'));
 assert((await service.exceptions(org,'2026-09-01','2026-09-01')).every(e=>e.type!=='school_closed'));
 await assert.rejects(service.addRecord(org,user,bed.id,{}),/Only draft/);
 p=await service.preview(org,bed.id,'revert');await service.apply(org,user,bed.id,{operation:'revert',token:p.token});
 assert(!(await service.exceptions(org,'2027-01-04','2027-01-04')).some(e=>e.type==='school_closed'));
 const revision=await service.revise(org,user,bed.id);assert.notEqual(revision.id,bed.id);
 await service.addRecord(org,user,revision.id,{date_from:'2027-01-04',date_to:'2027-01-04',reason:'Reopened',record_type:'open',verification_status:'confirmed',source_url:'https://example.org/term-dates'});
 versions=await service.list(org);assert.equal(forced(versions.find(v=>v.id===revision.id),'2027-01-04').length,0);
 await assert.rejects(service.preview(other,bed.id),/not found/);
 assert((await db.all('SELECT * FROM audit_log WHERE organisation_id = ?',[org])).length>=24);
 // Verify preloaded dates without re-entry, and capture joint mixed-school effects.
 await service.addRecord(org,user,ash.id,{date_from:'2027-01-04',date_to:'2027-01-04',reason:'INSET pending verification',record_type:'closed',verification_status:'provisional'});
 let ashVersion=(await service.list(org)).find(v=>v.id===ash.id), ashRecord=ashVersion.records.find(r=>r.reason==='INSET pending verification');
 await service.verifyRecord(org,user,ash.id,{record_id:ashRecord.id,source_url:'https://example.org/confirmed'});
 const joint=await service.bulkPreview(org,[revision.id,ash.id]);
 // Reopen override in the revision means only Ashley closes on 4 January: the shared run continues that day, so the only effects are Bede's own later closures.
 assert(joint.expected_invoice_effect<0);const jointJan=joint.details.find(r=>r.date==='2027-01-04');
 assert.equal(jointJan.invoice_effect,0);assert.equal(jointJan.driver_wages,0);assert.equal(jointJan.trips,2,'child participation changed on both runs');
 await service.addRecord(org,user,revision.id,{date_from:'2027-01-04',date_to:'2027-01-04',reason:'Confirmed closure restored',record_type:'closed',verification_status:'confirmed'});
 const combined=await service.bulkPreview(org,[revision.id,ash.id]);const jan=combined.details.find(r=>r.date==='2027-01-04');
 assert.equal(jan.invoice_effect,-100);assert.equal(jan.driver_wages,-60);assert.equal(jan.pa_wages,-40);assert.equal(jan.trips,2);assert.equal(combined.children.length,2);
 assert.equal(combined.expected_invoice_effect,joint.expected_invoice_effect-100);
 const future={academic_year:'2027/28',import_key:'future-year',schools:[{name:'Ashley Primary School',records:[{date_from:'2027-10-25',date_to:'2027-10-29',record_type:'closed',verification_status:'confirmed',reason:'Future half term'}]}]};
 await service.stageImport(org,user,future);await service.stageImport(org,user,future);
 const futureVersion=(await service.list(org)).filter(v=>v.academic_year==='2027/28');assert.equal(futureVersion.length,1);
 assert.equal(service.expand(futureVersion[0],'2026-10-24','2026-10-24',true).length,0);
 assert.equal(forced(futureVersion[0],'2027-10-25').length,1);
 await assert.rejects(service.stageImport(org,user,{...future,import_key:'invalid',schools:[{name:'Invalid',records:[{...future.schools[0].records[0],date_from:'2026-10-25'}]}]}),/Invalid calendar record/);
 // Term dates typed straight in: a live calendar takes them without a preview.
 versions=await service.list(org);const stm=get("St Mary's RC Primary School");
 p=await service.preview(org,stm.id);await service.apply(org,user,stm.id,{operation:'approve',token:p.token});
 const closedOn=async(date,school_id)=>(await service.exceptions(org,date,date)).filter(e=>e.type==='school_closed'&&e.school_id===school_id).length;
 assert.equal(await closedOn('2026-10-26',stm.school_id),0);
 let saved=await service.saveRecords(org,user,stm.id,{records:[...stm.records.map(r=>({...r,verification_status:'confirmed'})),{date_from:'2026-11-20',date_to:'2026-11-20',record_type:'closed',reason:'INSET day'}]});
 assert.equal(saved.version.verification_status,'verified');assert.deepEqual(saved.changes,{added:1,changed:9,removed:0});assert.equal(saved.warnings.length,0);
 for(const date of ['2026-10-26','2026-10-30','2026-11-20','2027-05-03']) assert.equal(await closedOn(date,stm.school_id),1);
 assert.equal((await service.list(org)).find(v=>v.id===stm.id).records.find(r=>r.reason==='INSET day').source_note,service.MANUAL);
 // Remove May Day, shorten Easter and open one half-term day: the newest entry wins.
 let records=saved.version.records.filter(r=>r.reason!=='May Day').map(r=>r.reason==='Easter'?{...r,date_to:'2027-04-02'}:r);
 records.push({date_from:'2026-10-28',date_to:'2026-10-28',record_type:'open',reason:'Open for a trip'});
 saved=await service.saveRecords(org,user,stm.id,{records});
 assert.deepEqual(saved.changes,{added:1,changed:1,removed:1});
 assert.equal(await closedOn('2027-05-03',stm.school_id),0);assert.equal(await closedOn('2027-04-05',stm.school_id),0);assert.equal(await closedOn('2027-04-01',stm.school_id),1);
 assert.equal(await closedOn('2026-10-28',stm.school_id),0);assert.equal(await closedOn('2026-10-27',stm.school_id),1);
 // Unticking Confirmed makes the dates provisional again; nothing else changes.
 saved=await service.saveRecords(org,user,stm.id,{records:saved.version.records.map(r=>r.reason==='INSET day'?{...r,verification_status:'provisional'}:r)});
 assert.deepEqual(saved.changes,{added:0,changed:1,removed:0});assert.equal(saved.version.verification_status,'partially_verified');assert.equal(await closedOn('2026-11-20',stm.school_id),0);
 assert((await service.exceptions(org,'2026-11-20','2026-11-20')).some(e=>e.type==='school_provisional'&&e.school_id===stm.school_id));
 for(const bad of [{records:[{date_from:'2026-10-26',date_to:'2026-10-25',reason:'x'}]},{records:[{date_from:'2026-08-01',date_to:'2026-08-01',reason:'x'}]},{records:[{date_from:'2026-10-26',date_to:'2026-10-26'}]},
   {records:[{id:999999,date_from:'2026-10-26',date_to:'2026-10-26',reason:'x'}]},{records:[{date_from:'2026-10-26',date_to:'2026-10-26',reason:'x',record_type:'withdrawn'}]},{records:[{date_from:'2026-10-26',date_to:'2026-10-26',reason:'x',source_url:'ftp://x'}]},{}])
   await assert.rejects(service.saveRecords(org,user,stm.id,bad));
 assert.equal((await service.list(org)).find(v=>v.id===stm.id).records.length,10);
 await assert.rejects(service.saveRecords(other,user,stm.id,{records:[]}),/not found/);
 await assert.rejects(service.saveRecords(org,user,bed.id,{records:[]}),/reversed/);
 // A draft can be edited the same way; it still needs approval to count.
 const ashNow=(await service.list(org)).find(v=>v.id===ash.id);
 assert((await service.saveRecords(org,user,ash.id,{records:ashNow.records})).warnings.some(w=>/draft/.test(w)));
 assert.equal(await closedOn('2026-10-26',ash.school_id),0);
 // A school with no calendar for the year gets a live one at once.
 const fresh=await add('schools',{name:'Brand New School'});
 const made=await service.create(org,user,{school_id:fresh,academic_year:'2026/27'});assert(made.created);
 assert.equal((await service.create(org,user,{school_id:fresh,academic_year:'2026/27'})).id,made.id);
 await assert.rejects(service.create(org,user,{school_id:fresh,academic_year:'2026'}),/academic year/);
 await assert.rejects(service.create(org,user,{school_id:fresh,academic_year:'2026/28'}),/academic year/);
 await assert.rejects(service.create(other,user,{school_id:fresh,academic_year:'2026/27'}),/School not found/);
 const madeVersion=(await service.list(org)).find(v=>v.id===made.id);assert.equal(madeVersion.state,'approved');assert.equal(madeVersion.effective_from,'2026-10-23');
 saved=await service.saveRecords(org,user,made.id,{records:[{date_from:'2026-10-26',date_to:'2026-10-30',reason:'October half term'},{date_from:'2026-10-19',date_to:'2026-10-19',reason:'Earlier INSET'}]});
 assert.equal(saved.warnings.length,1);assert.match(saved.warnings[0],/kept as they were/);
 assert.equal(await closedOn('2026-10-26',fresh),1);assert.equal(await closedOn('2026-10-19',fresh),0);
 assert.equal(await closedOn('2026-10-24',fresh),1);assert.equal(await closedOn('2026-10-17',fresh),0);
 assert.equal((await service.create(org,user,{school_id:fresh,academic_year:'2027/28'})).created,true);
 assert.equal((await service.list(org)).find(v=>v.school_id===fresh&&v.academic_year==='2027/28').effective_from,'2027-09-01');
 assert((await db.all("SELECT * FROM audit_log WHERE organisation_id = ? AND action IN ('term_dates','created')",[org])).length>=7);
 const routes=require('../server/routes');
 const call=async(method,path,body={})=>{const res={writeHead(status){this.status=status;},end(value){this.body=JSON.parse(value);}};await routes.handle({req:{method},res,path,query:{},body,user:{organisation_id:org,name:'Admin'}});return res;};
 assert.equal((await call('POST','/api/contracts',{code:'NO-SCHOOL'})).status,400);
 assert.equal((await call('POST','/api/children',{first_name:'No',last_name:'School'})).status,400);
 assert.equal((await call('GET','/api/academic-calendars')).status,200);
 assert.equal((await call('POST','/api/academic-calendars/bulk-preview',{version_ids:[revision.id,ash.id]})).body.expected_invoice_effect,combined.expected_invoice_effect);
 assert.equal((await call('PUT','/api/contracts/'+c,{school_id:ash.school_id})).status,200);
 const madeByRoute=await call('POST','/api/academic-calendars',{school_id:fresh,academic_year:'2028/29'});assert.equal(madeByRoute.status,201);
 assert.equal((await call('POST','/api/academic-calendars',{school_id:fresh,academic_year:'2028/29'})).status,200);
 assert.equal((await call('POST','/api/academic-calendars',{school_id:fresh,academic_year:'nope'})).status,400);
 const putRecords=await call('PUT','/api/academic-calendars/'+madeByRoute.body.id+'/records',{records:[{date_from:'2028-10-23',date_to:'2028-10-27',reason:'October half term'}]});
 assert.equal(putRecords.status,200);assert.equal(putRecords.body.version.records.length,1);assert.equal(putRecords.body.version.verification_status,'verified');
 assert.equal((await call('PUT','/api/academic-calendars/'+madeByRoute.body.id+'/records',{records:[{date_from:'2028-10-23',date_to:'2028-10-27'}]})).status,400);
 assert.equal((await db.get('SELECT school_id FROM children WHERE organisation_id = ? AND id = ?',[org,child1])).school_id,bed.school_id);
 console.log('Academic calendars passed: all 19 imports, idempotency, provisional safety, session boundaries, mixed-school trips, financial preview, stale approval, historical protection, reversal, amendments, direct term date edits and tenancy.');await db.close();mock.timers.reset();
})().catch(e=>{console.error(e);process.exitCode=1;});
