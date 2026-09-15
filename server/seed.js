'use strict';
// Demo data for one example operating firm.
//   npm run seed              adds the demo business if it is not already there
//   npm run seed -- --reset   removes the demo business first, leaving other firms alone
//
// This only ever touches the demo organisation. Real businesses that have
// registered through the sign-up screen are never modified.
const database = require('./db');
const { run, get, all, insert, setSetting } = database;
const auth = require('./services/auth');
const cal = require('./services/calendar');

const RESET = process.argv.includes('--reset');
const TODAY = cal.today();

function d(offset) { return cal.addDays(TODAY, offset); }

const DEMO_NAME = 'Northgate Home-to-School Transport';
const DEMO_EMAIL = 'demo@northgate-transport.example';

async function main() {
  await database.migrate(m => console.log(m));

  const existing = await get('SELECT id FROM organisations WHERE name = ?', [DEMO_NAME]);
  if (existing && !RESET) {
    console.log(`The demo business "${DEMO_NAME}" already exists (id ${existing.id}).`);
    console.log('Run with --reset to rebuild it. Other businesses are never touched.');
    return;
  }
  if (existing) {
    // Deleting the organisation cascades to every record that belongs to it.
    await run('DELETE FROM organisations WHERE id = ?', [existing.id]);
    console.log(`Removed the previous demo business (id ${existing.id}).`);
  }

  const orgId = await database.driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', [DEMO_NAME]);
  console.log(`Created demo business "${DEMO_NAME}" (id ${orgId}).`);

  await setSetting(orgId, 'amber_days', '30');
  await setSetting(orgId, 'company_name', DEMO_NAME);

  // ---- sign-in accounts for the demo business ----
  // Everyone who can sign in administers their own firm, so these are equals.
  for (const [email, password, name] of [
    [DEMO_EMAIL, 'demo1234', 'Dawn Whitfield'],
    ['rachel@northgate-transport.example', 'demo1234', 'Rachel Okafor'],
  ]) {
    await insert('users', { email, password_hash: auth.hash(password), name },
      ['email', 'password_hash', 'name'], null, orgId);
  }

  // ---- councils ----
  const councils = {};
  for (const c of [
    { name: 'Sunderland City Council', contact_name: 'Helen Marsh', phone: '0191 520 5555', email: 'transport@sunderland.gov.uk', address: 'Civic Centre, Burdon Road, Sunderland' },
    { name: 'Durham County Council', contact_name: 'Ian Pallister', phone: '03000 260 000', email: 'sentransport@durham.gov.uk', address: 'County Hall, Durham' },
    { name: 'Newcastle City Council', contact_name: 'Bev Turnbull', phone: '0191 278 7878', email: 'schooltransport@newcastle.gov.uk', address: 'Civic Centre, Barras Bridge, Newcastle' },
  ]) councils[c.name] = await insert('councils', c, ['name', 'contact_name', 'phone', 'email', 'address'], null, orgId);

  // ---- schools ----
  const schools = {};
  for (const s of [
    { name: 'Thornhill Park School', address: '21 Thornhill Park, Sunderland', postcode: 'SR2 7LA', phone: '0191 514 0659', contact_name: 'Marie Colledge', email: 'office@thornhillpark.co.uk', open_time: '09:00', close_time: '15:15', notes: 'Autism specialist school. Report to reception, sign in/out sheet at main door.' },
    { name: 'Barbara Priestman Academy', address: 'Meadowside, Sunderland', postcode: 'SR2 7QN', phone: '0191 553 6000', contact_name: 'Gavin Shaw', email: 'office@barbarapriestman.org', open_time: '08:45', close_time: '15:00' },
    { name: 'Portland Academy', address: 'Weymouth Road, Sunderland', postcode: 'SR3 4AF', phone: '0191 553 6000', contact_name: 'Lisa Moran', email: 'office@portlandacademy.org', open_time: '09:00', close_time: '15:10', notes: 'Wheelchair access via rear gate only.' },
    { name: 'Elemore Hall School', address: 'Pittington, Durham', postcode: 'DH6 1QD', phone: '0191 372 0275', contact_name: 'Tom Ridley', email: 'elemorehall@durhamlearning.net', open_time: '09:15', close_time: '15:20' },
    { name: 'Hadrian School', address: 'Bertram Crescent, Newcastle', postcode: 'NE15 6PY', phone: '0191 273 4440', contact_name: 'Angela Frost', email: 'admin@hadrian.newcastle.sch.uk', open_time: '09:00', close_time: '15:00' },
  ]) schools[s.name] = await insert('schools', s, ['name', 'address', 'postcode', 'phone', 'contact_name', 'email', 'open_time', 'close_time', 'notes'], null, orgId);

  // ---- staff ----
  const staff = {};
  const drivers = [
    { first_name: 'John', last_name: 'Reeve', postcode: 'SR3 1XP', address: '14 Silksworth Lane, Sunderland', phone: '07700 900112', email: 'j.reeve@example.com', default_day_rate: 60, badge_number: 'SUN/PHV/4471', licensing_authority: 'Sunderland City Council', dbs_number: '001234567890', emergency_contact_name: 'Karen Reeve', emergency_contact_phone: '07700 900113', start_date: '2021-09-01', preferred_areas: 'Sunderland south, Seaham' },
    { first_name: 'Ahmed', last_name: 'Khan', postcode: 'SR2 8HP', address: '5 Ryhope Road, Sunderland', phone: '07700 900220', email: 'a.khan@example.com', default_day_rate: 62, badge_number: 'SUN/PHV/5120', licensing_authority: 'Sunderland City Council', dbs_number: '001234567891', emergency_contact_name: 'Sadia Khan', emergency_contact_phone: '07700 900221', start_date: '2022-01-10', preferred_areas: 'Sunderland, Houghton' },
    { first_name: 'Marta', last_name: 'Nowak', postcode: 'SR4 7DF', address: '88 Chester Road, Sunderland', phone: '07700 900330', email: 'm.nowak@example.com', default_day_rate: 58, badge_number: 'SUN/PHV/6003', licensing_authority: 'Sunderland City Council', dbs_number: '001234567892', start_date: '2023-04-17', preferred_areas: 'Sunderland west' },
    { first_name: 'Dennis', last_name: 'Okonkwo', postcode: 'DH6 1AB', address: '3 Front Street, Sherburn', phone: '07700 900440', email: 'd.okonkwo@example.com', default_day_rate: 65, badge_number: 'DUR/PHV/2210', licensing_authority: 'Durham County Council', dbs_number: '001234567893', start_date: '2020-09-07', preferred_areas: 'Durham, Sherburn, Pittington' },
    { first_name: 'Susan', last_name: 'Blakey', postcode: 'NE15 7AA', address: '12 Denton Road, Newcastle', phone: '07700 900550', email: 's.blakey@example.com', default_day_rate: 64, badge_number: 'NCL/PHV/9981', licensing_authority: 'Newcastle City Council', dbs_number: '001234567894', start_date: '2022-09-05', preferred_areas: 'Newcastle west' },
    { first_name: 'Ray', last_name: 'Chesterton', postcode: 'SR5 3AB', address: '41 Fulwell Road, Sunderland', phone: '07700 900660', email: 'r.chesterton@example.com', default_day_rate: 60, status: 'pool', badge_number: 'SUN/PHV/7712', licensing_authority: 'Sunderland City Council', availability: 'Mon-Fri AM only', preferred_areas: 'Sunderland north, Washington' },
    { first_name: 'Priya', last_name: 'Raman', postcode: 'SR3 3PP', address: '9 Doxford Park Way, Sunderland', phone: '07700 900770', email: 'p.raman@example.com', default_day_rate: 63, status: 'pool', badge_number: 'SUN/PHV/8890', licensing_authority: 'Sunderland City Council', availability: 'Full time, immediate start', preferred_areas: 'Sunderland south' },
  ];
  const pas = [
    { first_name: 'Linda', last_name: 'Fairbairn', postcode: 'SR2 9QQ', address: '22 Grangetown Road, Sunderland', phone: '07700 900810', email: 'l.fairbairn@example.com', default_day_rate: 35, dbs_number: '002234567890', emergency_contact_name: 'Peter Fairbairn', emergency_contact_phone: '07700 900811', start_date: '2021-09-01', preferred_areas: 'Sunderland south' },
    { first_name: 'Gemma', last_name: 'Shipley', postcode: 'SR4 6TT', address: '76 Hylton Road, Sunderland', phone: '07700 900820', email: 'g.shipley@example.com', default_day_rate: 34, dbs_number: '002234567891', start_date: '2022-09-05', preferred_areas: 'Sunderland west' },
    { first_name: 'Carl', last_name: 'Dempsey', postcode: 'DH6 2RR', address: '17 Station Road, Sherburn Hill', phone: '07700 900830', email: 'c.dempsey@example.com', default_day_rate: 36, dbs_number: '002234567892', start_date: '2023-01-09', preferred_areas: 'Durham' },
    { first_name: 'Aisha', last_name: 'Bello', postcode: 'NE15 8DD', address: '4 Whitehall Road, Newcastle', phone: '07700 900840', email: 'a.bello@example.com', default_day_rate: 35, dbs_number: '002234567893', start_date: '2023-09-04', preferred_areas: 'Newcastle' },
    { first_name: 'Tracy', last_name: 'Hoban', postcode: 'SR5 2LL', address: '30 Southwick Road, Sunderland', phone: '07700 900850', email: 't.hoban@example.com', default_day_rate: 35, status: 'pool', availability: 'Available for cover at short notice', preferred_areas: 'Sunderland north' },
    { first_name: 'Michael', last_name: 'Arturo', postcode: 'SR2 7BB', address: '15 Mowbray Road, Sunderland', phone: '07700 900860', email: 'm.arturo@example.com', default_day_rate: 37, status: 'pool', availability: 'PM journeys only', preferred_areas: 'Sunderland central' },
  ];
  for (const s of drivers) staff[`${s.first_name} ${s.last_name}`] = await insert('staff', { ...s, type: 'driver' }, ['type', 'first_name', 'last_name', 'address', 'postcode', 'phone', 'email', 'emergency_contact_name', 'emergency_contact_phone', 'status', 'licensing_authority', 'badge_number', 'dbs_number', 'default_day_rate', 'availability', 'preferred_areas', 'start_date', 'notes'], null, orgId);
  for (const s of pas) staff[`${s.first_name} ${s.last_name}`] = await insert('staff', { ...s, type: 'pa' }, ['type', 'first_name', 'last_name', 'address', 'postcode', 'phone', 'email', 'emergency_contact_name', 'emergency_contact_phone', 'status', 'licensing_authority', 'badge_number', 'dbs_number', 'default_day_rate', 'availability', 'preferred_areas', 'start_date', 'notes'], null, orgId);

  // ---- vehicles ----
  const vehicles = {};
  for (const v of [
    { driver: 'John Reeve', registration: 'NL21 XKD', make: 'Ford', model: 'Tourneo Custom', seats: 8, wheelchair_accessible: 1, colour: 'Silver' },
    { driver: 'Ahmed Khan', registration: 'NK70 VBG', make: 'Peugeot', model: 'Traveller', seats: 8, wheelchair_accessible: 0, colour: 'Grey' },
    { driver: 'Marta Nowak', registration: 'SD19 PRT', make: 'Vauxhall', model: 'Vivaro', seats: 6, wheelchair_accessible: 1, colour: 'White' },
    { driver: 'Dennis Okonkwo', registration: 'DU22 HFL', make: 'Mercedes-Benz', model: 'Vito', seats: 8, wheelchair_accessible: 1, colour: 'Blue' },
    { driver: 'Susan Blakey', registration: 'NE23 TYU', make: 'Volkswagen', model: 'Caravelle', seats: 7, wheelchair_accessible: 0, colour: 'Black' },
    { driver: 'Ray Chesterton', registration: 'SR68 MNB', make: 'Renault', model: 'Trafic', seats: 8, wheelchair_accessible: 0, colour: 'White' },
    { driver: 'Priya Raman', registration: 'NL23 QWE', make: 'Ford', model: 'Tourneo Connect', seats: 5, wheelchair_accessible: 1, colour: 'Red' },
  ]) vehicles[v.registration] = await insert('vehicles', { ...v, driver_id: staff[v.driver] }, ['driver_id', 'registration', 'make', 'model', 'seats', 'wheelchair_accessible', 'colour'], null, orgId);

  // ---- contracts ----
  const contracts = {};
  const contractDefs = [
    { code: 'THORNHILL PARK 1', name: 'Thornhill Park AM/PM run 1', council: 'Sunderland City Council', council_ref: 'SCC/HTS/2026/114', school: 'Thornhill Park School', driver: 'John Reeve', pa: 'Linda Fairbairn', vehicle: 'NL21 XKD', am_pickup_time: '07:50', am_arrival_time: '08:55', pm_finish_time: '15:15', pm_dropoff_time: '16:20', income_per_day: 148, driver_pay_per_day: 60, pa_pay_per_day: 35, other_costs_per_day: 6, route_info: 'Silksworth -> Ryhope -> Grangetown -> Thornhill Park', start_date: '2026-09-01', end_date: '2027-07-21' },
    { code: 'THORNHILL PARK 2', name: 'Thornhill Park AM/PM run 2', council: 'Sunderland City Council', council_ref: 'SCC/HTS/2026/115', school: 'Thornhill Park School', driver: 'Marta Nowak', pa: 'Gemma Shipley', vehicle: 'SD19 PRT', am_pickup_time: '07:45', am_arrival_time: '08:55', pm_finish_time: '15:15', pm_dropoff_time: '16:25', income_per_day: 136, driver_pay_per_day: 58, pa_pay_per_day: 34, other_costs_per_day: 6, route_info: 'Pennywell -> Chester Road -> Thornhill Park', start_date: '2026-09-01', end_date: '2027-07-21' },
    { code: 'PORTLAND 1', name: 'Portland Academy wheelchair run', council: 'Sunderland City Council', council_ref: 'SCC/HTS/2026/207', school: 'Portland Academy', driver: 'Ahmed Khan', pa: 'Michael Arturo', vehicle: 'NK70 VBG', am_pickup_time: '08:00', am_arrival_time: '08:55', pm_finish_time: '15:10', pm_dropoff_time: '16:05', income_per_day: 155, driver_pay_per_day: 62, pa_pay_per_day: 37, other_costs_per_day: 7, route_info: 'Doxford Park -> Farringdon -> Portland Academy', start_date: '2026-09-01', end_date: '2027-07-21' },
    { code: 'BARBARA P 1', name: 'Barbara Priestman run', council: 'Sunderland City Council', council_ref: 'SCC/HTS/2026/301', school: 'Barbara Priestman Academy', driver: 'John Reeve', pa: null, requires_pa: 0, vehicle: 'NL21 XKD', am_pickup_time: '08:05', am_arrival_time: '08:40', pm_finish_time: '15:00', pm_dropoff_time: '15:40', income_per_day: 92, driver_pay_per_day: 45, pa_pay_per_day: 0, other_costs_per_day: 4, route_info: 'Hendon -> Barbara Priestman', start_date: '2026-09-01', end_date: '2027-07-21', days_of_week: '1,2,3,4,5' },
    { code: 'ELEMORE 1', name: 'Elemore Hall Durham run', council: 'Durham County Council', council_ref: 'DCC/SEN/26/0442', school: 'Elemore Hall School', driver: 'Dennis Okonkwo', pa: 'Carl Dempsey', vehicle: 'DU22 HFL', am_pickup_time: '07:40', am_arrival_time: '09:05', pm_finish_time: '15:20', pm_dropoff_time: '16:45', income_per_day: 172, driver_pay_per_day: 65, pa_pay_per_day: 36, other_costs_per_day: 9, route_info: 'Sherburn -> Pittington -> Elemore Hall', start_date: '2026-09-01', end_date: '2027-07-21' },
    { code: 'HADRIAN 1', name: 'Hadrian School Newcastle run', council: 'Newcastle City Council', council_ref: 'NCC/HTS/26/88', school: 'Hadrian School', driver: 'Susan Blakey', pa: 'Aisha Bello', vehicle: 'NE23 TYU', am_pickup_time: '07:55', am_arrival_time: '08:50', pm_finish_time: '15:00', pm_dropoff_time: '15:55', income_per_day: 150, driver_pay_per_day: 64, pa_pay_per_day: 35, other_costs_per_day: 7, route_info: 'Benwell -> Denton -> Hadrian School', start_date: '2026-09-01', end_date: '2027-07-21' },
    { code: 'PORTLAND 2', name: 'Portland Academy second run (awaiting staff)', council: 'Sunderland City Council', council_ref: 'SCC/HTS/2026/208', school: 'Portland Academy', driver: null, pa: null, vehicle: null, am_pickup_time: '08:00', am_arrival_time: '08:55', pm_finish_time: '15:10', pm_dropoff_time: '16:10', income_per_day: 140, driver_pay_per_day: 60, pa_pay_per_day: 35, other_costs_per_day: 6, route_info: 'Washington -> Portland Academy', start_date: d(7), end_date: '2027-07-21', status: 'pending', notes: 'Starts next week. Driver and PA still to be allocated from the pool.' },
  ];
  for (const c of contractDefs) {
    contracts[c.code] = await insert('contracts', {
      code: c.code, name: c.name, council_id: councils[c.council], council_ref: c.council_ref,
      school_id: schools[c.school], driver_id: c.driver ? staff[c.driver] : null, pa_id: c.pa ? staff[c.pa] : null,
      vehicle_id: c.vehicle ? vehicles[c.vehicle] : null, requires_pa: c.requires_pa === undefined ? 1 : c.requires_pa,
      status: c.status || 'active', start_date: c.start_date, end_date: c.end_date, days_of_week: c.days_of_week || '1,2,3,4,5',
      am_pickup_time: c.am_pickup_time, am_arrival_time: c.am_arrival_time, pm_finish_time: c.pm_finish_time, pm_dropoff_time: c.pm_dropoff_time,
      route_info: c.route_info, income_per_day: c.income_per_day, income_basis: 'per_journey',
      driver_pay_per_day: c.driver_pay_per_day, pa_pay_per_day: c.pa_pay_per_day, pay_basis: 'per_journey',
      other_costs_per_day: c.other_costs_per_day, notes: c.notes,
    }, ['code', 'name', 'council_id', 'council_ref', 'school_id', 'driver_id', 'pa_id', 'vehicle_id', 'requires_pa', 'status', 'start_date', 'end_date', 'days_of_week', 'am_pickup_time', 'am_arrival_time', 'pm_finish_time', 'pm_dropoff_time', 'route_info', 'income_per_day', 'income_basis', 'driver_pay_per_day', 'pa_pay_per_day', 'pay_basis', 'other_costs_per_day', 'notes'], null, orgId);
  }

  // ---- children ----
  const childDefs = [
    { first_name: 'Alfie', last_name: 'Brennan', dob: '2014-03-11', address: '7 Silksworth Row, Sunderland', postcode: 'SR3 1AA', parent_name: 'Claire Brennan', parent_phone: '07700 901001', emergency_contact_name: 'Dave Brennan (father)', emergency_contact_phone: '07700 901002', contract: 'THORNHILL PARK 1', pickup_time: '07:50', arrival_time: '08:55', finish_time: '15:15', dropoff_time: '16:20', council_ref: 'SCC-CH-4471', sen_needs: 'EHCP - autism spectrum condition', conditions: 'Autism, sensory processing difficulties', communication: 'Uses short verbal phrases plus PECS cards. Give processing time.', behaviour: 'Can become distressed by loud noise and sudden route changes. Advance warning of any change is essential.', medical_info: 'No regular medication.', allergies: 'None known', safeguarding_info: 'Handover to named adult only. Mother or father.', risk_info: 'Must sit in the same seat each journey (front left bench). Seat belt check before moving.', wheelchair: 0 },
    { first_name: 'Maisie', last_name: 'Cotterill', dob: '2013-07-22', address: '19 Ryhope Street South, Sunderland', postcode: 'SR2 0AB', parent_name: 'Jen Cotterill', parent_phone: '07700 901010', contract: 'THORNHILL PARK 1', pickup_time: '08:05', arrival_time: '08:55', finish_time: '15:15', dropoff_time: '16:05', council_ref: 'SCC-CH-4502', sen_needs: 'EHCP - ADHD and moderate learning difficulty', conditions: 'ADHD', medical_info: 'Methylphenidate taken at school, not in transport.', allergies: 'Penicillin', behaviour: 'Needs seating away from other pupils where possible.', wheelchair: 0 },
    { first_name: 'Ibrahim', last_name: 'Saeed', dob: '2015-01-05', address: '3 Grangetown Terrace, Sunderland', postcode: 'SR2 9PL', parent_name: 'Nadia Saeed', parent_phone: '07700 901020', emergency_contact_name: 'Yusuf Saeed', emergency_contact_phone: '07700 901021', contract: 'THORNHILL PARK 1', pickup_time: '08:15', arrival_time: '08:55', finish_time: '15:15', dropoff_time: '15:55', council_ref: 'SCC-CH-4533', sen_needs: 'EHCP - global developmental delay', mobility: 'Walks short distances, needs a hand to and from the door.', medical_info: 'Epilepsy - rescue medication held at school. Call 999 for any seizure over 5 minutes.', allergies: 'None known', risk_info: 'Epilepsy care plan on file. PA must be seated adjacent.', wheelchair: 0 },
    { first_name: 'Freya', last_name: 'Dunnett', dob: '2012-11-30', address: '44 Pennywell Road, Sunderland', postcode: 'SR4 9AA', parent_name: 'Kelly Dunnett', parent_phone: '07700 901030', contract: 'THORNHILL PARK 2', pickup_time: '07:45', arrival_time: '08:55', finish_time: '15:15', dropoff_time: '16:25', council_ref: 'SCC-CH-4610', sen_needs: 'EHCP - autism', conditions: 'Autism, selective mutism', communication: 'Does not speak in transport. Uses a communication book.', wheelchair: 0 },
    { first_name: 'Theo', last_name: 'Marchetti', dob: '2013-05-14', address: '8 Chester Road, Sunderland', postcode: 'SR4 7HH', parent_name: 'Gina Marchetti', parent_phone: '07700 901040', contract: 'THORNHILL PARK 2', pickup_time: '08:00', arrival_time: '08:55', finish_time: '15:15', dropoff_time: '16:10', council_ref: 'SCC-CH-4622', sen_needs: 'EHCP - autism and anxiety', behaviour: 'Anxious about new staff. Introduce cover staff to parent at the door.', wheelchair: 0 },
    { first_name: 'Harper', last_name: 'Ellison', dob: '2011-09-02', address: '2 Doxford Park Way, Sunderland', postcode: 'SR3 2PL', parent_name: 'Lou Ellison', parent_phone: '07700 901050', contract: 'PORTLAND 1', pickup_time: '08:00', arrival_time: '08:55', finish_time: '15:10', dropoff_time: '16:05', council_ref: 'SCC-CH-4701', sen_needs: 'EHCP - PMLD', mobility: 'Full-time wheelchair user, self-propelling indoors.', wheelchair: 1, medical_info: 'PEG fed at school. Suction unit travels with the child.', risk_info: 'Four-point wheelchair restraint. Clamps checked by driver and PA before every journey.', safeguarding_info: 'Two-person handover required.' },
    { first_name: 'Noah', last_name: 'Feeney', dob: '2010-12-19', address: '31 Farringdon Row, Sunderland', postcode: 'SR3 3DD', parent_name: 'Marie Feeney', parent_phone: '07700 901060', contract: 'PORTLAND 1', pickup_time: '08:15', arrival_time: '08:55', finish_time: '15:10', dropoff_time: '15:50', council_ref: 'SCC-CH-4715', sen_needs: 'EHCP - severe learning difficulty', mobility: 'Ambulant, unsteady on steps.', wheelchair: 0, behaviour: 'Will try to open the door at traffic lights. Child locks must be on at all times.' },
    { first_name: 'Ruby', last_name: 'Tennant', dob: '2012-02-08', address: '60 Hendon Road, Sunderland', postcode: 'SR1 2AA', parent_name: 'Steph Tennant', parent_phone: '07700 901070', contract: 'BARBARA P 1', pickup_time: '08:05', arrival_time: '08:40', finish_time: '15:00', dropoff_time: '15:40', council_ref: 'SCC-CH-4802', sen_needs: 'EHCP - moderate learning difficulty', notes: 'Travels independently with driver only. No PA required on this contract.' },
    { first_name: 'Caleb', last_name: 'Wharton', dob: '2011-06-25', address: '12 Front Street, Sherburn', postcode: 'DH6 1AD', parent_name: 'Andrea Wharton', parent_phone: '07700 901080', contract: 'ELEMORE 1', pickup_time: '07:40', arrival_time: '09:05', finish_time: '15:20', dropoff_time: '16:45', council_ref: 'DCC-CH-2201', sen_needs: 'EHCP - SEMH', behaviour: 'Positive handling plan on file. De-escalate, do not restrain in vehicle.' },
    { first_name: 'Evie', last_name: 'Ramsbottom', dob: '2012-04-03', address: '5 Hallgarth View, Pittington', postcode: 'DH6 1AP', parent_name: 'Chris Ramsbottom', parent_phone: '07700 901090', contract: 'ELEMORE 1', pickup_time: '08:05', arrival_time: '09:05', finish_time: '15:20', dropoff_time: '16:20', council_ref: 'DCC-CH-2244', sen_needs: 'EHCP - SEMH and dyslexia', allergies: 'Nut allergy - EpiPen carried in school bag at all times.', medical_info: 'Anaphylaxis plan on file. EpiPen must travel with the child.' },
    { first_name: 'Musa', last_name: 'Adeyemi', dob: '2014-08-17', address: '14 Benwell Lane, Newcastle', postcode: 'NE15 6RS', parent_name: 'Tolu Adeyemi', parent_phone: '07700 901100', contract: 'HADRIAN 1', pickup_time: '07:55', arrival_time: '08:50', finish_time: '15:00', dropoff_time: '15:55', council_ref: 'NCC-CH-7712', sen_needs: 'EHCP - PMLD', wheelchair: 1, mobility: 'Wheelchair user, hoisted at home by parent.', risk_info: 'Wheelchair restraint checked before departure.' },
    { first_name: 'Lacey', last_name: 'Ord', dob: '2013-10-09', address: '22 Denton Park Grove, Newcastle', postcode: 'NE15 7LF', parent_name: 'Donna Ord', parent_phone: '07700 901110', contract: 'HADRIAN 1', pickup_time: '08:10', arrival_time: '08:50', finish_time: '15:00', dropoff_time: '15:40', council_ref: 'NCC-CH-7740', sen_needs: 'EHCP - Down syndrome', medical_info: 'Hearing aids worn. Check both are in before leaving home.' },
  ];
  for (const c of childDefs) {
    const contractId = contracts[c.contract];
    const schoolId = (await get('SELECT school_id FROM contracts WHERE organisation_id = ? AND id = ?', [orgId, contractId])).school_id;
    await insert('children', { ...c, contract_id: contractId, school_id: schoolId, status: 'active' },
      ['first_name', 'last_name', 'dob', 'address', 'postcode', 'parent_name', 'parent_phone', 'emergency_contact_name', 'emergency_contact_phone', 'school_id', 'contract_id', 'council_ref', 'pickup_time', 'arrival_time', 'finish_time', 'dropoff_time', 'medical_info', 'sen_needs', 'conditions', 'mobility', 'wheelchair', 'behaviour', 'communication', 'allergies', 'safeguarding_info', 'risk_info', 'notes', 'status'], null, orgId);
  }

  // ---- documents (drives the traffic lights: some green, some amber, some red) ----
  const docs = [
    // John Reeve - fully compliant
    ['staff', 'John Reeve', 'Driving Licence', d(700)], ['staff', 'John Reeve', 'Driver Badge', d(420)],
    ['staff', 'John Reeve', 'DBS', d(310)], ['staff', 'John Reeve', 'Safeguarding Training', d(260)],
    ['vehicle', 'NL21 XKD', 'Vehicle Insurance', d(180)], ['vehicle', 'NL21 XKD', 'MOT', d(150)], ['vehicle', 'NL21 XKD', 'Vehicle Licence', d(200)],
    // Ahmed Khan - amber, badge expiring soon
    ['staff', 'Ahmed Khan', 'Driving Licence', d(900)], ['staff', 'Ahmed Khan', 'Driver Badge', d(18)],
    ['staff', 'Ahmed Khan', 'DBS', d(400)], ['staff', 'Ahmed Khan', 'Safeguarding Training', d(500)],
    ['vehicle', 'NK70 VBG', 'Vehicle Insurance', d(95)], ['vehicle', 'NK70 VBG', 'MOT', d(24)], ['vehicle', 'NK70 VBG', 'Vehicle Licence', d(300)],
    // Marta Nowak - red, DBS expired
    ['staff', 'Marta Nowak', 'Driving Licence', d(1100)], ['staff', 'Marta Nowak', 'Driver Badge', d(240)],
    ['staff', 'Marta Nowak', 'DBS', d(-12)], ['staff', 'Marta Nowak', 'Safeguarding Training', d(330)],
    ['vehicle', 'SD19 PRT', 'Vehicle Insurance', d(210)], ['vehicle', 'SD19 PRT', 'MOT', d(88)], ['vehicle', 'SD19 PRT', 'Vehicle Licence', d(150)],
    // Dennis Okonkwo - green
    ['staff', 'Dennis Okonkwo', 'Driving Licence', d(1300)], ['staff', 'Dennis Okonkwo', 'Driver Badge', d(600)],
    ['staff', 'Dennis Okonkwo', 'DBS', d(520)], ['staff', 'Dennis Okonkwo', 'Safeguarding Training', d(410)],
    ['vehicle', 'DU22 HFL', 'Vehicle Insurance', d(260)], ['vehicle', 'DU22 HFL', 'MOT', d(190)], ['vehicle', 'DU22 HFL', 'Vehicle Licence', d(280)],
    // Susan Blakey - amber MOT
    ['staff', 'Susan Blakey', 'Driving Licence', d(800)], ['staff', 'Susan Blakey', 'Driver Badge', d(380)],
    ['staff', 'Susan Blakey', 'DBS', d(290)], ['staff', 'Susan Blakey', 'Safeguarding Training', d(170)],
    ['vehicle', 'NE23 TYU', 'Vehicle Insurance', d(140)], ['vehicle', 'NE23 TYU', 'MOT', d(11)], ['vehicle', 'NE23 TYU', 'Vehicle Licence', d(220)],
    // pool drivers
    ['staff', 'Ray Chesterton', 'Driving Licence', d(950)], ['staff', 'Ray Chesterton', 'Driver Badge', d(300)],
    ['staff', 'Ray Chesterton', 'DBS', d(250)], ['staff', 'Ray Chesterton', 'Safeguarding Training', d(360)],
    ['vehicle', 'SR68 MNB', 'Vehicle Insurance', d(120)], ['vehicle', 'SR68 MNB', 'MOT', d(70)], ['vehicle', 'SR68 MNB', 'Vehicle Licence', d(190)],
    ['staff', 'Priya Raman', 'Driving Licence', d(1000)], ['staff', 'Priya Raman', 'Driver Badge', d(450)],
    ['staff', 'Priya Raman', 'DBS', d(480)], ['staff', 'Priya Raman', 'Safeguarding Training', d(390)],
    ['vehicle', 'NL23 QWE', 'Vehicle Insurance', d(230)], ['vehicle', 'NL23 QWE', 'MOT', d(160)], ['vehicle', 'NL23 QWE', 'Vehicle Licence', d(240)],
    // PAs
    ['staff', 'Linda Fairbairn', 'DBS', d(340)], ['staff', 'Linda Fairbairn', 'Safeguarding Training', d(280)], ['staff', 'Linda Fairbairn', 'PA Training', d(420)],
    ['staff', 'Gemma Shipley', 'DBS', d(21)], ['staff', 'Gemma Shipley', 'Safeguarding Training', d(310)], ['staff', 'Gemma Shipley', 'PA Training', d(360)],
    ['staff', 'Carl Dempsey', 'DBS', d(430)], ['staff', 'Carl Dempsey', 'Safeguarding Training', d(390)], ['staff', 'Carl Dempsey', 'PA Training', d(470)],
    ['staff', 'Aisha Bello', 'DBS', d(510)], ['staff', 'Aisha Bello', 'Safeguarding Training', d(460)],
    ['staff', 'Tracy Hoban', 'DBS', d(220)], ['staff', 'Tracy Hoban', 'Safeguarding Training', d(200)], ['staff', 'Tracy Hoban', 'PA Training', d(240)],
    ['staff', 'Michael Arturo', 'DBS', d(600)], ['staff', 'Michael Arturo', 'Safeguarding Training', d(550)], ['staff', 'Michael Arturo', 'PA Training', d(580)],
  ];
  for (const [entityType, key, docType, expiry] of docs) {
    const entityId = entityType === 'staff' ? staff[key] : vehicles[key];
    if (!entityId) { console.warn('missing entity for doc', key); continue; }
    await insert('documents', {
      entity_type: entityType, entity_id: entityId, doc_type: docType,
      issue_date: cal.addDays(expiry, -365), expiry_date: expiry, status: 'valid', uploaded_by: 'Seed data',
      notes: 'Demo record - no file attached',
    }, ['entity_type', 'entity_id', 'doc_type', 'issue_date', 'expiry_date', 'status', 'uploaded_by', 'notes'], null, orgId);
  }
  // Aisha Bello is missing PA Training entirely -> amber/red via "missing"

  // ---- exceptions over the last few weeks, demonstrating every mechanism ----
  const lastWeekday = n => { let x = d(-n); while ([0, 6].includes(cal.dow(x))) x = cal.addDays(x, -1); return x; };
  const childId = async name => {
    const [first, ...rest] = name.split(' ');
    const r = await get('SELECT id FROM children WHERE first_name = ? AND last_name = ?', [first, rest.join(' ')]);
    return r ? r.id : null;
  };
  const ex = [];
  ex.push({ date: lastWeekday(3), type: 'child_absence', leg: 'DAY', contract_id: contracts['THORNHILL PARK 1'], child_id: await childId('Alfie Brennan'), note: 'Parent rang - unwell' });
  ex.push({ date: lastWeekday(4), type: 'child_absence', leg: 'PM', contract_id: contracts['THORNHILL PARK 1'], child_id: await childId('Maisie Cotterill'), note: 'Collected by parent from school' });
  ex.push({ date: lastWeekday(5), type: 'staff_absence', leg: 'DAY', contract_id: contracts['THORNHILL PARK 1'], role: 'driver', staff_id: staff['John Reeve'], cover_staff_id: staff['Ahmed Khan'], cover_pay: 75, paid_immediately: 1, note: 'John at hospital appointment. Ahmed covered, paid same day in cash.' });
  ex.push({ date: lastWeekday(2), type: 'staff_absence', leg: 'AM', contract_id: contracts['THORNHILL PARK 2'], role: 'pa', staff_id: staff['Gemma Shipley'], cover_staff_id: staff['Tracy Hoban'], cover_pay: 22, paid_immediately: 0, note: 'Gemma delayed, Tracy covered AM only' });
  ex.push({ date: lastWeekday(6), type: 'school_closed', leg: 'DAY', school_id: schools['Thornhill Park School'], note: 'Staff training day' });
  ex.push({ date: lastWeekday(1), type: 'staff_absence', leg: 'DAY', contract_id: contracts['ELEMORE 1'], role: 'driver', staff_id: staff['Dennis Okonkwo'], cover_staff_id: null, note: 'Dennis off sick, no cover found - journey did not run' });
  ex.push({ date: lastWeekday(7), type: 'journey_cancelled', leg: 'PM', contract_id: contracts['HADRIAN 1'], note: 'Severe weather, school closed early and parents collected' });
  ex.push({ date: d(1), type: 'staff_absence', leg: 'DAY', contract_id: contracts['PORTLAND 1'], role: 'driver', staff_id: staff['Ahmed Khan'], cover_staff_id: staff['Priya Raman'], cover_pay: 70, paid_immediately: 0, note: 'Pre-booked leave - Priya allocated from the pool' });
  ex.push({ date: TODAY, type: 'child_absence', leg: 'DAY', contract_id: contracts['PORTLAND 1'], child_id: await childId('Noah Feeney'), note: 'Hospital appointment' });
  ex.push({ date: TODAY, type: 'staff_absence', leg: 'DAY', contract_id: contracts['HADRIAN 1'], role: 'pa', staff_id: staff['Aisha Bello'], cover_staff_id: null, note: 'Aisha off sick - cover still required' });

  for (const e of ex) {
    const id = await insert('exceptions', { ...e, created_by: 'Seed data' }, ['date', 'type', 'leg', 'contract_id', 'school_id', 'child_id', 'role', 'staff_id', 'cover_staff_id', 'cover_pay', 'paid_immediately', 'amount', 'note', 'created_by'], null, orgId);
    if (e.paid_immediately && e.cover_staff_id) {
      await insert('payments', { staff_id: e.cover_staff_id, work_date: e.date, paid_date: e.date, amount: e.cover_pay, source: 'cover_immediate', exception_id: id, note: 'Cover paid immediately', created_by: 'Seed data' },
        ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'note', 'created_by'], null, orgId);
    }
  }

  // ---- a couple of ad-hoc expenses ----
  await insert('expenses', { date: lastWeekday(4), contract_id: contracts['ELEMORE 1'], category: 'Fuel', amount: 48.5, description: 'Additional fuel - diversion via Hetton', created_by: 'Seed data' }, ['date', 'contract_id', 'category', 'amount', 'description', 'created_by'], null, orgId);
  await insert('expenses', { date: lastWeekday(9), contract_id: contracts['PORTLAND 1'], category: 'Vehicle repair', amount: 165, description: 'Wheelchair ramp hinge replacement', created_by: 'Seed data' }, ['date', 'contract_id', 'category', 'amount', 'description', 'created_by'], null, orgId);

  const summary = await get(`SELECT
      (SELECT COUNT(*) FROM councils  WHERE organisation_id = ?) AS councils,
      (SELECT COUNT(*) FROM schools   WHERE organisation_id = ?) AS schools,
      (SELECT COUNT(*) FROM staff     WHERE organisation_id = ?) AS staff,
      (SELECT COUNT(*) FROM contracts WHERE organisation_id = ?) AS contracts,
      (SELECT COUNT(*) FROM children  WHERE organisation_id = ?) AS children,
      (SELECT COUNT(*) FROM documents WHERE organisation_id = ?) AS documents,
      (SELECT COUNT(*) FROM exceptions WHERE organisation_id = ?) AS exceptions`, Array(7).fill(orgId));

  console.log('');
  console.log('Demo business seeded on ' + database.describe);
  console.log('  Councils  :', Number(summary.councils));
  console.log('  Schools   :', Number(summary.schools));
  console.log('  Staff     :', Number(summary.staff));
  console.log('  Contracts :', Number(summary.contracts));
  console.log('  Children  :', Number(summary.children));
  console.log('  Documents :', Number(summary.documents));
  console.log('  Exceptions:', Number(summary.exceptions));
  const total = Number((await get('SELECT COUNT(*) AS n FROM organisations')).n);
  console.log('');
  console.log('Sign in at http://localhost:4000 with:');
  console.log('  ' + DEMO_EMAIL + '  /  demo1234');
  console.log('');
  console.log(total + (total === 1 ? ' business' : ' businesses') + ' registered in total. Each sees only its own records.');
}

main()
  .then(() => database.close())
  .catch(async e => {
    console.error('\nSeed failed:', e.message);
    try { await database.close(); } catch (_) {}
    process.exit(1);
  });
