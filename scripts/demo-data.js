/**
 * Fills an existing business with realistic demo data, for showing the system to people.
 *
 *   npm run demo -- "Tyne and Wear Cars"
 *   npm run demo -- "Tyne and Wear Cars" --replace    clear that business first
 *   npm run demo -- --list                            show the businesses available
 *
 * It only ever touches the one business named on the command line, and by
 * default it adds to what is already there rather than replacing it. Anything
 * you created yourself is kept and woven into the demo where it fits.
 *
 * The children, staff and families are invented. The schools and councils are
 * real places, so the routes look like real work.
 */
'use strict';
require('../server/env').load();

const database = require('../server/db');
const { all, get, run, insert, setSetting } = database;
const auth = require('../server/services/auth');
const cal = require('../server/services/calendar');

const args = process.argv.slice(2);
const REPLACE = args.includes('--replace');
const LIST = args.includes('--list');
// Adds only the weekly schedules and child timetables, leaving every other
// record alone. Useful on a business that was filled before they existed.
const PATTERNS_ONLY = args.includes('--patterns');
const NAME = args.filter(a => !a.startsWith('--')).join(' ').trim();
// Two businesses are allowed to share a name, so an id settles which one.
const ID_AT = args.indexOf('--id');
const ORG_ID = ID_AT >= 0 && args[ID_AT + 1] ? Number(args[ID_AT + 1]) : null;

const TODAY = cal.today();
const d = n => cal.addDays(TODAY, n);
/** The most recent weekday n days back, so demo exceptions never land on a weekend. */
const weekday = n => { let x = d(-n); while ([0, 6].includes(cal.dow(x))) x = cal.addDays(x, -1); return x; };

// Term dates for the current school year, so the calendar is populated either way.
const TERM_START = TODAY < `${TODAY.slice(0, 4)}-09-01` ? `${Number(TODAY.slice(0, 4)) - 1}-09-01` : `${TODAY.slice(0, 4)}-09-01`;
const TERM_END = `${Number(TERM_START.slice(0, 4)) + 1}-07-21`;

// ---------------------------------------------------------------- data
const COUNCILS = [
  { name: 'Newcastle City Council', contact_name: 'Bev Turnbull', phone: '0191 278 7878', email: 'schooltransport@newcastle.gov.uk', address: 'Civic Centre, Barras Bridge, Newcastle upon Tyne' },
  { name: 'North Tyneside Council', contact_name: 'Alan Pearce', phone: '0345 2000 101', email: 'sentransport@northtyneside.gov.uk', address: 'Quadrant, The Silverlink North, Cobalt Business Park' },
  { name: 'Gateshead Council', contact_name: 'Michelle Dodds', phone: '0191 433 3000', email: 'homeschooltransport@gateshead.gov.uk', address: 'Civic Centre, Regent Street, Gateshead' },
  { name: 'South Tyneside Council', contact_name: 'Ravi Menon', phone: '0191 427 7000', email: 'transport@southtyneside.gov.uk', address: 'Town Hall, Westoe Road, South Shields' },
];

const SCHOOLS = [
  { name: 'Hadrian School', address: 'Bertram Crescent, Benwell, Newcastle', postcode: 'NE15 6PY', phone: '0191 273 4440', contact_name: 'Angela Frost', email: 'admin@hadrian.newcastle.sch.uk', open_time: '09:00', close_time: '15:00', notes: 'PMLD and SLD. Hoisting available. Report to reception; escorts sign the daily handover sheet.' },
  { name: 'Thomas Bewick School', address: 'Linhope Road, West Denton, Newcastle', postcode: 'NE5 2LW', phone: '0191 700 7400', contact_name: 'Craig Simpson', email: 'office@thomasbewick.newcastle.sch.uk', open_time: '09:10', close_time: '15:10', notes: 'Autism specialist. Quiet drop-off at the side gate; avoid the main car park at finish time.' },
  { name: 'Sir Charles Parsons School', address: 'Westbourne Avenue, Walker, Newcastle', postcode: 'NE6 4SS', phone: '0191 295 4000', contact_name: 'Diane Whitfield', email: 'office@sircharlesparsons.newcastle.sch.uk', open_time: '09:00', close_time: '15:15' },
  { name: 'Beacon Hill School', address: 'Rising Sun Cottages, Wallsend', postcode: 'NE28 9JP', phone: '0191 643 3000', contact_name: 'Paul Hardy', email: 'office@beaconhill.org.uk', open_time: '09:00', close_time: '15:05', notes: 'Wheelchair bay at the rear entrance. Two-minute wait limit on the front road.' },
  { name: 'Woodlawn School', address: 'Langley Avenue, Monkseaton, Whitley Bay', postcode: 'NE26 2JB', phone: '0191 643 8786', contact_name: 'Sarah Kenyon', email: 'office@woodlawn.school', open_time: '09:15', close_time: '15:15' },
  { name: 'Gibside School', address: 'Burnthouse Lane, Whickham, Gateshead', postcode: 'NE16 5AT', phone: '0191 433 5000', contact_name: 'Helen Bryson', email: 'office@gibside.gateshead.sch.uk', open_time: '09:00', close_time: '15:00' },
  { name: 'Dryden School', address: 'Shotley Gardens, Low Fell, Gateshead', postcode: 'NE9 5UR', phone: '0191 433 4111', contact_name: 'Mark Easton', email: 'office@dryden.gateshead.sch.uk', open_time: '09:05', close_time: '15:05', notes: 'Steep approach; minibuses use the upper gate in icy weather.' },
  { name: 'Bamburgh School', address: 'Norham Avenue North, South Shields', postcode: 'NE34 7TD', phone: '0191 456 1591', contact_name: 'Joanne Tate', email: 'office@bamburghschool.org', open_time: '09:00', close_time: '15:10' },
  { name: 'Epinay School', address: 'Clervaux Terrace, Jarrow', postcode: 'NE32 5UP', phone: '0191 489 7480', contact_name: 'Stephen Lunn', email: 'office@epinay.org.uk', open_time: '09:00', close_time: '15:00' },
];

const DRIVERS = [
  { first_name: 'Ian', last_name: 'Charlton', postcode: 'NE15 7QT', address: '12 Denton Park Grove, Newcastle', phone: '07700 900201', email: 'i.charlton@example.com', default_day_rate: 64, badge_number: 'NCL/PHV/4412', licensing_authority: 'Newcastle City Council', dbs_number: '003100045001', emergency_contact_name: 'Julie Charlton', emergency_contact_phone: '07700 900202', start_date: '2021-09-06', preferred_areas: 'Newcastle west, Denton, Benwell' },
  { first_name: 'Shabana', last_name: 'Iqbal', postcode: 'NE6 5RT', address: '4 Shields Road, Byker, Newcastle', phone: '07700 900203', email: 's.iqbal@example.com', default_day_rate: 66, badge_number: 'NCL/PHV/5021', licensing_authority: 'Newcastle City Council', dbs_number: '003100045002', start_date: '2022-01-10', preferred_areas: 'Newcastle east, Walker, Byker' },
  { first_name: 'Gary', last_name: 'Nesbitt', postcode: 'NE28 8LP', address: '31 Station Road, Wallsend', phone: '07700 900205', email: 'g.nesbitt@example.com', default_day_rate: 62, badge_number: 'NTC/PHV/2210', licensing_authority: 'North Tyneside Council', dbs_number: '003100045003', emergency_contact_name: 'Denise Nesbitt', emergency_contact_phone: '07700 900206', start_date: '2020-09-07', preferred_areas: 'Wallsend, Howdon, North Shields' },
  { first_name: 'Katarzyna', last_name: 'Lewandowska', postcode: 'NE26 3PN', address: '9 Park Avenue, Whitley Bay', phone: '07700 900207', email: 'k.lewandowska@example.com', default_day_rate: 65, badge_number: 'NTC/PHV/2688', licensing_authority: 'North Tyneside Council', dbs_number: '003100045004', start_date: '2023-04-17', preferred_areas: 'Whitley Bay, Monkseaton, Tynemouth' },
  { first_name: 'Derek', last_name: 'Almond', postcode: 'NE16 4QD', address: '18 Front Street, Whickham, Gateshead', phone: '07700 900209', email: 'd.almond@example.com', default_day_rate: 63, badge_number: 'GAT/PHV/7741', licensing_authority: 'Gateshead Council', dbs_number: '003100045005', start_date: '2019-09-02', preferred_areas: 'Whickham, Blaydon, Ryton' },
  { first_name: 'Funmi', last_name: 'Adebayo', postcode: 'NE9 6TH', address: '27 Durham Road, Low Fell, Gateshead', phone: '07700 900211', email: 'f.adebayo@example.com', default_day_rate: 64, badge_number: 'GAT/PHV/8003', licensing_authority: 'Gateshead Council', dbs_number: '003100045006', emergency_contact_name: 'Tunde Adebayo', emergency_contact_phone: '07700 900212', start_date: '2022-09-05', preferred_areas: 'Low Fell, Felling, Birtley' },
  { first_name: 'Stuart', last_name: 'Kerrigan', postcode: 'NE34 6PB', address: '55 Sunderland Road, South Shields', phone: '07700 900213', email: 's.kerrigan@example.com', default_day_rate: 62, badge_number: 'STC/PHV/3312', licensing_authority: 'South Tyneside Council', dbs_number: '003100045007', start_date: '2021-03-15', preferred_areas: 'South Shields, Harton, Cleadon' },
  { first_name: 'Maureen', last_name: 'Docherty', postcode: 'NE32 3DL', address: '6 Grange Road, Jarrow', phone: '07700 900215', email: 'm.docherty@example.com', default_day_rate: 61, status: 'pool', badge_number: 'STC/PHV/3980', licensing_authority: 'South Tyneside Council', availability: 'Mon to Fri, AM runs only', preferred_areas: 'Jarrow, Hebburn' },
  { first_name: 'Tomasz', last_name: 'Wojcik', postcode: 'NE5 3JN', address: '2 Ponteland Road, Cowgate, Newcastle', phone: '07700 900217', email: 't.wojcik@example.com', default_day_rate: 65, status: 'pool', badge_number: 'NCL/PHV/6120', licensing_authority: 'Newcastle City Council', availability: 'Full time, available immediately', preferred_areas: 'Newcastle north and west' },
];

const PAS = [
  { first_name: 'Christine', last_name: 'Bell', postcode: 'NE15 8DQ', address: '3 Whitehall Road, Newcastle', phone: '07700 900301', email: 'c.bell@example.com', default_day_rate: 38, dbs_number: '003200055001', emergency_contact_name: 'Rob Bell', emergency_contact_phone: '07700 900302', start_date: '2021-09-06', preferred_areas: 'Newcastle west' },
  { first_name: 'Amara', last_name: 'Nwosu', postcode: 'NE6 2QL', address: '14 Welbeck Road, Walker, Newcastle', phone: '07700 900303', email: 'a.nwosu@example.com', default_day_rate: 37, dbs_number: '003200055002', start_date: '2022-09-05', preferred_areas: 'Newcastle east' },
  { first_name: 'Lesley', last_name: 'Rutherford', postcode: 'NE28 7AB', address: '40 High Street East, Wallsend', phone: '07700 900305', email: 'l.rutherford@example.com', default_day_rate: 36, dbs_number: '003200055003', start_date: '2020-09-07', preferred_areas: 'Wallsend, North Shields' },
  { first_name: 'Joanne', last_name: 'Sculthorpe', postcode: 'NE25 8QE', address: '11 Earsdon Road, Whitley Bay', phone: '07700 900307', email: 'j.sculthorpe@example.com', default_day_rate: 38, dbs_number: '003200055004', start_date: '2023-09-04', preferred_areas: 'Whitley Bay, Monkseaton' },
  { first_name: 'Paul', last_name: 'Teasdale', postcode: 'NE16 3BN', address: '8 Chase Park, Whickham, Gateshead', phone: '07700 900309', email: 'p.teasdale@example.com', default_day_rate: 37, dbs_number: '003200055005', start_date: '2021-11-01', preferred_areas: 'Whickham, Blaydon' },
  { first_name: 'Nadia', last_name: 'Hussain', postcode: 'NE9 7LP', address: '22 Split Crow Road, Felling, Gateshead', phone: '07700 900311', email: 'n.hussain@example.com', default_day_rate: 36, dbs_number: '003200055006', start_date: '2023-01-09', preferred_areas: 'Gateshead' },
  { first_name: 'Susan', last_name: 'Fenwick', postcode: 'NE34 0PQ', address: '19 Marsden Road, South Shields', phone: '07700 900313', email: 's.fenwick@example.com', default_day_rate: 37, status: 'pool', availability: 'Available for cover at short notice', preferred_areas: 'South Shields, Jarrow' },
  { first_name: 'Michael', last_name: 'Oyelaran', postcode: 'NE6 4DW', address: '5 Fossway, Walker, Newcastle', phone: '07700 900315', email: 'm.oyelaran@example.com', default_day_rate: 39, status: 'pool', availability: 'PM runs only during term time', preferred_areas: 'Newcastle east' },
];

const VEHICLES = [
  { driver: 'Ian Charlton', registration: 'NL72 KDV', make: 'Ford', model: 'Tourneo Custom', seats: 8, wheelchair_accessible: 1, colour: 'White' },
  { driver: 'Shabana Iqbal', registration: 'NE71 PXG', make: 'Peugeot', model: 'Traveller', seats: 8, wheelchair_accessible: 0, colour: 'Grey' },
  { driver: 'Gary Nesbitt', registration: 'NK69 TYB', make: 'Mercedes-Benz', model: 'Vito Tourer', seats: 8, wheelchair_accessible: 1, colour: 'Silver' },
  { driver: 'Katarzyna Lewandowska', registration: 'NU21 WSM', make: 'Vauxhall', model: 'Vivaro Life', seats: 7, wheelchair_accessible: 1, colour: 'Blue' },
  { driver: 'Derek Almond', registration: 'GH20 RLC', make: 'Renault', model: 'Trafic', seats: 8, wheelchair_accessible: 0, colour: 'White' },
  { driver: 'Funmi Adebayo', registration: 'NL19 HFP', make: 'Volkswagen', model: 'Caravelle', seats: 7, wheelchair_accessible: 0, colour: 'Black' },
  { driver: 'Stuart Kerrigan', registration: 'ST70 MND', make: 'Ford', model: 'Transit Custom', seats: 8, wheelchair_accessible: 1, colour: 'Silver' },
  { driver: 'Maureen Docherty', registration: 'NE18 JCB', make: 'Citroen', model: 'Dispatch', seats: 6, wheelchair_accessible: 0, colour: 'Red' },
  { driver: 'Tomasz Wojcik', registration: 'NL23 XKP', make: 'Ford', model: 'Tourneo Connect', seats: 5, wheelchair_accessible: 1, colour: 'Grey' },
];

const CONTRACTS = [
  { code: 'HADRIAN AM/PM 1', name: 'Hadrian School wheelchair run', council: 'Newcastle City Council', council_ref: 'NCC/HTS/26/0114', school: 'Hadrian School', driver: 'Ian Charlton', pa: 'Christine Bell', vehicle: 'NL72 KDV', am_pickup_time: '07:50', am_arrival_time: '08:55', pm_finish_time: '15:00', pm_dropoff_time: '16:05', income_per_day: 168, driver_pay_per_day: 64, pa_pay_per_day: 38, other_costs_per_day: 8, route_info: 'Denton Burn, Benwell, Scotswood, then Hadrian School' },
  { code: 'HADRIAN AM/PM 2', name: 'Hadrian School second run', council: 'Newcastle City Council', council_ref: 'NCC/HTS/26/0115', school: 'Hadrian School', driver: 'Tomasz Wojcik', pa: 'Michael Oyelaran', vehicle: 'NL23 XKP', am_pickup_time: '07:55', am_arrival_time: '08:55', pm_finish_time: '15:00', pm_dropoff_time: '16:00', income_per_day: 142, driver_pay_per_day: 65, pa_pay_per_day: 39, other_costs_per_day: 7, route_info: 'Cowgate, Kenton, Fenham, then Hadrian School' },
  { code: 'BEWICK 1', name: 'Thomas Bewick autism run', council: 'Newcastle City Council', council_ref: 'NCC/HTS/26/0207', school: 'Thomas Bewick School', driver: 'Shabana Iqbal', pa: 'Amara Nwosu', vehicle: 'NE71 PXG', am_pickup_time: '08:00', am_arrival_time: '09:05', pm_finish_time: '15:10', pm_dropoff_time: '16:15', income_per_day: 155, driver_pay_per_day: 66, pa_pay_per_day: 37, other_costs_per_day: 7, route_info: 'Byker, Heaton, Jesmond, then West Denton' },
  { code: 'PARSONS 1', name: 'Sir Charles Parsons run', council: 'Newcastle City Council', council_ref: 'NCC/HTS/26/0301', school: 'Sir Charles Parsons School', driver: 'Shabana Iqbal', pa: null, requires_pa: 0, vehicle: 'NE71 PXG', am_pickup_time: '08:15', am_arrival_time: '08:55', pm_finish_time: '15:15', pm_dropoff_time: '15:55', income_per_day: 96, driver_pay_per_day: 46, pa_pay_per_day: 0, other_costs_per_day: 4, route_info: 'Walker and Wallsend Road, short run, no PA required' },
  { code: 'BEACON HILL 1', name: 'Beacon Hill Wallsend run', council: 'North Tyneside Council', council_ref: 'NTC/SEN/26/441', school: 'Beacon Hill School', driver: 'Gary Nesbitt', pa: 'Lesley Rutherford', vehicle: 'NK69 TYB', am_pickup_time: '07:45', am_arrival_time: '08:55', pm_finish_time: '15:05', pm_dropoff_time: '16:15', income_per_day: 172, driver_pay_per_day: 62, pa_pay_per_day: 36, other_costs_per_day: 9, route_info: 'Howdon, Willington Quay, Wallsend, then Rising Sun' },
  { code: 'WOODLAWN 1', name: 'Woodlawn coastal run', council: 'North Tyneside Council', council_ref: 'NTC/SEN/26/512', school: 'Woodlawn School', driver: 'Katarzyna Lewandowska', pa: 'Joanne Sculthorpe', vehicle: 'NU21 WSM', am_pickup_time: '08:00', am_arrival_time: '09:10', pm_finish_time: '15:15', pm_dropoff_time: '16:20', income_per_day: 164, driver_pay_per_day: 65, pa_pay_per_day: 38, other_costs_per_day: 8, route_info: 'Tynemouth, Cullercoats, Monkseaton, then Woodlawn' },
  { code: 'WOODLAWN 2', name: 'Woodlawn second run', council: 'North Tyneside Council', council_ref: 'NTC/SEN/26/513', school: 'Woodlawn School', driver: 'Maureen Docherty', pa: 'Susan Fenwick', vehicle: 'NE18 JCB', am_pickup_time: '08:05', am_arrival_time: '09:10', pm_finish_time: '15:15', pm_dropoff_time: '16:10', income_per_day: 138, driver_pay_per_day: 61, pa_pay_per_day: 37, other_costs_per_day: 6, route_info: 'Shiremoor, Backworth, then Woodlawn' },
  { code: 'GIBSIDE 1', name: 'Gibside Whickham run', council: 'Gateshead Council', council_ref: 'GAT/HST/26/088', school: 'Gibside School', driver: 'Derek Almond', pa: 'Paul Teasdale', vehicle: 'GH20 RLC', am_pickup_time: '07:55', am_arrival_time: '08:55', pm_finish_time: '15:00', pm_dropoff_time: '16:00', income_per_day: 150, driver_pay_per_day: 63, pa_pay_per_day: 37, other_costs_per_day: 7, route_info: 'Blaydon, Ryton, Winlaton, then Whickham' },
  { code: 'DRYDEN 1', name: 'Dryden Low Fell run', council: 'Gateshead Council', council_ref: 'GAT/HST/26/092', school: 'Dryden School', driver: 'Funmi Adebayo', pa: 'Nadia Hussain', vehicle: 'NL19 HFP', am_pickup_time: '08:05', am_arrival_time: '09:00', pm_finish_time: '15:05', pm_dropoff_time: '16:00', income_per_day: 146, driver_pay_per_day: 64, pa_pay_per_day: 36, other_costs_per_day: 6, route_info: 'Felling, Wrekenton, Birtley, then Low Fell' },
  { code: 'BAMBURGH 1', name: 'Bamburgh South Shields run', council: 'South Tyneside Council', council_ref: 'STC/HST/26/019', school: 'Bamburgh School', driver: 'Stuart Kerrigan', pa: 'Susan Fenwick', vehicle: 'ST70 MND', am_pickup_time: '07:50', am_arrival_time: '08:55', pm_finish_time: '15:10', pm_dropoff_time: '16:15', income_per_day: 158, driver_pay_per_day: 62, pa_pay_per_day: 37, other_costs_per_day: 8, route_info: 'Cleadon, Whitburn, Harton, then Bamburgh' },
  { code: 'EPINAY 1', name: 'Epinay Jarrow run', council: 'South Tyneside Council', council_ref: 'STC/HST/26/024', school: 'Epinay School', driver: 'MOHAMMED', pa: 'Michael Oyelaran', vehicle: null, am_pickup_time: '08:00', am_arrival_time: '08:55', pm_finish_time: '15:00', pm_dropoff_time: '15:55', income_per_day: 134, driver_pay_per_day: 50, pa_pay_per_day: 39, other_costs_per_day: 6, route_info: 'Hebburn, Jarrow, then Clervaux Terrace' },
  { code: 'BEWICK 2', name: 'Thomas Bewick additional run', council: 'Newcastle City Council', council_ref: 'NCC/HTS/26/0208', school: 'Thomas Bewick School', driver: null, pa: null, vehicle: null, status: 'pending', am_pickup_time: '08:00', am_arrival_time: '09:05', pm_finish_time: '15:10', pm_dropoff_time: '16:10', income_per_day: 148, driver_pay_per_day: 62, pa_pay_per_day: 37, other_costs_per_day: 6, route_info: 'Gosforth and Kingston Park, then West Denton', notes: 'Awarded last week, starts after half term. Driver and PA still to be allocated from the pool.', start_offset: 21 },
];

const CHILDREN = [
  { first_name: 'Reuben', last_name: 'Aldridge', dob: '2014-02-11', address: '7 Ferguson Crescent, Denton Burn, Newcastle', postcode: 'NE15 7BS', parent_name: 'Gemma Aldridge', parent_phone: '07700 901401', emergency_contact_name: 'Craig Aldridge (father)', emergency_contact_phone: '07700 901402', contract: 'HADRIAN AM/PM 1', council_ref: 'NCC-CH-3301', sen_needs: 'EHCP, profound and multiple learning difficulties', wheelchair: 1, mobility: 'Full-time wheelchair user, hoisted at home by parent', medical_info: 'PEG fed at school. Suction unit travels with him.', risk_info: 'Four-point wheelchair restraint. Clamps checked by driver and PA before every journey.', safeguarding_info: 'Two-person handover, to a named adult only.', pickup_time: '07:50', dropoff_time: '16:05' },
  { first_name: 'Tia', last_name: 'Blenkinsop', dob: '2013-06-29', address: '22 Ferndale Avenue, Benwell, Newcastle', postcode: 'NE15 6RJ', parent_name: 'Donna Blenkinsop', parent_phone: '07700 901403', contract: 'HADRIAN AM/PM 1', council_ref: 'NCC-CH-3312', sen_needs: 'EHCP, severe learning difficulty', mobility: 'Walks with a frame, needs a steadying hand at the kerb', medical_info: 'Epilepsy. Care plan on file, rescue medication held at school.', risk_info: 'PA seated adjacent at all times. Call 999 for any seizure over five minutes.', pickup_time: '08:05', dropoff_time: '15:50' },
  { first_name: 'Callum', last_name: 'Sharkey', dob: '2015-01-08', address: '4 Armstrong Road, Scotswood, Newcastle', postcode: 'NE15 6UX', parent_name: 'Leanne Sharkey', parent_phone: '07700 901405', contract: 'HADRIAN AM/PM 1', council_ref: 'NCC-CH-3330', sen_needs: 'EHCP, PMLD', wheelchair: 1, communication: 'Non-verbal. Responds to familiar voices and music.', pickup_time: '08:15', dropoff_time: '15:40' },
  { first_name: 'Elsie', last_name: 'Ferguson', dob: '2012-11-02', address: '18 Ponteland Road, Cowgate, Newcastle', postcode: 'NE5 3AE', parent_name: 'Kirsty Ferguson', parent_phone: '07700 901407', contract: 'HADRIAN AM/PM 2', council_ref: 'NCC-CH-3402', sen_needs: 'EHCP, SLD and hearing impairment', medical_info: 'Hearing aids worn. Check both are in before leaving home.', pickup_time: '07:55', dropoff_time: '16:00' },
  { first_name: 'Haris', last_name: 'Mahmood', dob: '2014-09-19', address: '33 Kenton Lane, Newcastle', postcode: 'NE3 3BB', parent_name: 'Sadia Mahmood', parent_phone: '07700 901409', emergency_contact_name: 'Imran Mahmood', emergency_contact_phone: '07700 901410', contract: 'HADRIAN AM/PM 2', council_ref: 'NCC-CH-3418', sen_needs: 'EHCP, global developmental delay', behaviour: 'Settles quickly if seated in the same place each journey.', pickup_time: '08:10', dropoff_time: '15:45' },
  { first_name: 'Jacob', last_name: 'Riddell', dob: '2013-04-23', address: '9 Raby Street, Byker, Newcastle', postcode: 'NE6 2HX', parent_name: 'Stacey Riddell', parent_phone: '07700 901411', contract: 'BEWICK 1', council_ref: 'NCC-CH-3501', sen_needs: 'EHCP, autism spectrum condition', conditions: 'Autism, sensory processing difficulties', communication: 'Short verbal phrases plus a picture book. Give processing time.', behaviour: 'Distressed by loud noise and route changes. Warn in advance of any change.', pickup_time: '08:00', dropoff_time: '16:15' },
  { first_name: 'Amelia', last_name: 'Coyne', dob: '2012-08-14', address: '61 Chillingham Road, Heaton, Newcastle', postcode: 'NE6 5XN', parent_name: 'Rachel Coyne', parent_phone: '07700 901413', contract: 'BEWICK 1', council_ref: 'NCC-CH-3524', sen_needs: 'EHCP, autism and anxiety', allergies: 'Nut allergy. EpiPen travels in her school bag at all times.', medical_info: 'Anaphylaxis plan on file. No food to be shared in the vehicle.', pickup_time: '08:12', dropoff_time: '16:00' },
  { first_name: 'Oliver', last_name: 'Tweddle', dob: '2015-03-30', address: '2 Osborne Road, Jesmond, Newcastle', postcode: 'NE2 2AE', parent_name: 'Hannah Tweddle', parent_phone: '07700 901415', contract: 'BEWICK 1', council_ref: 'NCC-CH-3540', sen_needs: 'EHCP, autism', communication: 'Uses a communication device. Does not speak in transport.', pickup_time: '08:25', dropoff_time: '15:45' },
  { first_name: 'Sophie', last_name: 'Hetherington', dob: '2011-12-05', address: '14 Welbeck Road, Walker, Newcastle', postcode: 'NE6 2JQ', parent_name: 'Lisa Hetherington', parent_phone: '07700 901417', contract: 'PARSONS 1', council_ref: 'NCC-CH-3602', sen_needs: 'EHCP, moderate learning difficulty', notes: 'Travels independently with the driver. No PA required on this contract.', pickup_time: '08:15', dropoff_time: '15:55' },
  { first_name: 'Nathan', last_name: 'Purvis', dob: '2011-05-17', address: '40 Wallsend Road, Newcastle', postcode: 'NE6 4TQ', parent_name: 'Mandy Purvis', parent_phone: '07700 901419', contract: 'PARSONS 1', council_ref: 'NCC-CH-3611', sen_needs: 'EHCP, MLD and dyslexia', pickup_time: '08:22', dropoff_time: '15:48' },
  { first_name: 'Lily', last_name: 'Waugh', dob: '2013-10-12', address: '5 Tynemouth Road, Howdon, Wallsend', postcode: 'NE28 0QP', parent_name: 'Claire Waugh', parent_phone: '07700 901421', contract: 'BEACON HILL 1', council_ref: 'NTC-CH-2101', sen_needs: 'EHCP, PMLD', wheelchair: 1, mobility: 'Wheelchair user. Ramp loading at the rear of the vehicle.', risk_info: 'Restraints checked before departure, both directions.', pickup_time: '07:45', dropoff_time: '16:15' },
  { first_name: 'Ethan', last_name: 'Stobbart', dob: '2012-07-07', address: '26 Willington Terrace, Wallsend', postcode: 'NE28 6UT', parent_name: 'Nicola Stobbart', parent_phone: '07700 901423', contract: 'BEACON HILL 1', council_ref: 'NTC-CH-2118', sen_needs: 'EHCP, SEMH', behaviour: 'Positive handling plan on file. De-escalate; no restraint in the vehicle.', pickup_time: '08:00', dropoff_time: '15:55' },
  { first_name: 'Maisie', last_name: 'Dunn', dob: '2014-04-02', address: '11 Station Road, Wallsend', postcode: 'NE28 8RR', parent_name: 'Zoe Dunn', parent_phone: '07700 901425', contract: 'BEACON HILL 1', council_ref: 'NTC-CH-2130', sen_needs: 'EHCP, SLD', allergies: 'None known', pickup_time: '08:12', dropoff_time: '15:40' },
  { first_name: 'Isaac', last_name: 'Pattison', dob: '2013-01-26', address: '3 Percy Gardens, Tynemouth', postcode: 'NE30 4HQ', parent_name: 'Emma Pattison', parent_phone: '07700 901427', contract: 'WOODLAWN 1', council_ref: 'NTC-CH-2202', sen_needs: 'EHCP, autism', behaviour: 'Will try the door at traffic lights. Child locks on at all times.', pickup_time: '08:00', dropoff_time: '16:20' },
  { first_name: 'Grace', last_name: 'Milburn', dob: '2012-09-09', address: '29 Marden Road, Cullercoats', postcode: 'NE30 3AR', parent_name: 'Sarah Milburn', parent_phone: '07700 901429', contract: 'WOODLAWN 1', council_ref: 'NTC-CH-2216', sen_needs: 'EHCP, Down syndrome', medical_info: 'Mild hypotonia. Helped in and out of the vehicle.', pickup_time: '08:15', dropoff_time: '16:05' },
  { first_name: 'Finlay', last_name: 'Ord', dob: '2014-06-21', address: '8 Front Street, Monkseaton, Whitley Bay', postcode: 'NE25 8DP', parent_name: 'Katie Ord', parent_phone: '07700 901431', contract: 'WOODLAWN 1', council_ref: 'NTC-CH-2225', sen_needs: 'EHCP, autism and ADHD', pickup_time: '08:28', dropoff_time: '15:45' },
  { first_name: 'Ava', last_name: 'Chambers', dob: '2013-03-15', address: '17 Brenkley Avenue, Shiremoor', postcode: 'NE27 0PZ', parent_name: 'Jodie Chambers', parent_phone: '07700 901433', contract: 'WOODLAWN 2', council_ref: 'NTC-CH-2304', sen_needs: 'EHCP, SLD', pickup_time: '08:05', dropoff_time: '16:10' },
  { first_name: 'Logan', last_name: 'Bewick', dob: '2012-12-01', address: '4 Station Road, Backworth', postcode: 'NE27 0AD', parent_name: 'Amy Bewick', parent_phone: '07700 901435', contract: 'WOODLAWN 2', council_ref: 'NTC-CH-2318', sen_needs: 'EHCP, SEMH', pickup_time: '08:18', dropoff_time: '15:55' },
  { first_name: 'Poppy', last_name: 'Surtees', dob: '2014-08-08', address: '12 Shibdon Road, Blaydon', postcode: 'NE21 5PT', parent_name: 'Chelsea Surtees', parent_phone: '07700 901437', contract: 'GIBSIDE 1', council_ref: 'GAT-CH-1102', sen_needs: 'EHCP, SLD', wheelchair: 0, mobility: 'Unsteady on steps. Hand held to and from the door.', pickup_time: '07:55', dropoff_time: '16:00' },
  { first_name: 'Harry', last_name: 'Dodds', dob: '2011-10-24', address: '6 Main Road, Ryton', postcode: 'NE40 3AJ', parent_name: 'Vicky Dodds', parent_phone: '07700 901439', contract: 'GIBSIDE 1', council_ref: 'GAT-CH-1115', sen_needs: 'EHCP, autism', communication: 'Prefers no conversation on the journey. Quiet radio is fine.', pickup_time: '08:08', dropoff_time: '15:50' },
  { first_name: 'Mia', last_name: 'Gallagher', dob: '2013-05-05', address: '31 Split Crow Road, Felling, Gateshead', postcode: 'NE10 9AB', parent_name: 'Shannon Gallagher', parent_phone: '07700 901441', contract: 'DRYDEN 1', council_ref: 'GAT-CH-1201', sen_needs: 'EHCP, MLD and speech and language needs', pickup_time: '08:05', dropoff_time: '16:00' },
  { first_name: 'Dylan', last_name: 'Charlton', dob: '2012-02-18', address: '9 Old Durham Road, Wrekenton, Gateshead', postcode: 'NE9 7AA', parent_name: 'Laura Charlton', parent_phone: '07700 901443', contract: 'DRYDEN 1', council_ref: 'GAT-CH-1214', sen_needs: 'EHCP, SEMH', behaviour: 'Needs a seat away from other pupils where possible.', pickup_time: '08:18', dropoff_time: '15:45' },
  { first_name: 'Erin', last_name: 'Kirkbride', dob: '2014-11-11', address: '2 Sea Road, Cleadon', postcode: 'NE34 8AB', parent_name: 'Beth Kirkbride', parent_phone: '07700 901445', contract: 'BAMBURGH 1', council_ref: 'STC-CH-0902', sen_needs: 'EHCP, autism', pickup_time: '07:50', dropoff_time: '16:15' },
  { first_name: 'Alfie', last_name: 'Storey', dob: '2013-07-27', address: '15 Whitburn Road, Whitburn', postcode: 'NE34 7NJ', parent_name: 'Natalie Storey', parent_phone: '07700 901447', contract: 'BAMBURGH 1', council_ref: 'STC-CH-0918', sen_needs: 'EHCP, PMLD', wheelchair: 1, risk_info: 'Wheelchair clamps and lap belt checked by both staff.', pickup_time: '08:05', dropoff_time: '16:00' },
  { first_name: 'Ruby', last_name: 'Hindmarsh', dob: '2015-02-03', address: '28 Harton Lane, South Shields', postcode: 'NE34 6EF', parent_name: 'Jade Hindmarsh', parent_phone: '07700 901449', contract: 'BAMBURGH 1', council_ref: 'STC-CH-0930', sen_needs: 'EHCP, SLD', pickup_time: '08:20', dropoff_time: '15:45' },
  { first_name: 'Noah', last_name: 'Cassidy', dob: '2012-06-16', address: '7 Victoria Road West, Hebburn', postcode: 'NE31 1LQ', parent_name: 'Paige Cassidy', parent_phone: '07700 901451', contract: 'EPINAY 1', council_ref: 'STC-CH-1001', sen_needs: 'EHCP, MLD', pickup_time: '08:00', dropoff_time: '15:55' },
  { first_name: 'Isla', last_name: 'Redpath', dob: '2013-09-23', address: '20 Grange Road, Jarrow', postcode: 'NE32 3LD', parent_name: 'Courtney Redpath', parent_phone: '07700 901453', contract: 'EPINAY 1', council_ref: 'STC-CH-1014', sen_needs: 'EHCP, autism', allergies: 'Dairy intolerance', pickup_time: '08:14', dropoff_time: '15:42' },
];

// Weekly schedules for the contracts whose week is not the same every day.
// Everything else runs the standard one out, one back, and needs nothing here.
const AM = t => ({ label: 'AM school drop-off', kind: 'outbound', depart_time: t });
const PM = t => ({ label: 'PM school collection', kind: 'return', depart_time: t });
const SCHEDULES = [
  {
    contract: 'BEWICK 1',
    note: 'Autumn term. Friday is a split collection.',
    days: {
      1: [AM('08:00'), PM('15:10')],
      2: [AM('08:00'), PM('15:10')],
      3: [AM('08:00'), PM('15:10')],
      4: [AM('08:00'), PM('15:10')],
      5: [
        AM('08:00'),
        { label: '1pm early collection', kind: 'return', depart_time: '13:00', children: ['Jacob Riddell', 'Amelia Coyne'] },
        { label: '3pm collection', kind: 'return', depart_time: '15:00', children: ['Oliver Tweddle'] },
      ],
    },
  },
  {
    contract: 'PARSONS 1',
    note: 'College timetable. No Wednesday, early finish on Friday.',
    days: {
      1: [AM('08:15'), PM('15:15')],
      2: [AM('08:15'), PM('15:15')],
      4: [AM('08:15'), PM('15:15')],
      5: [AM('08:15'), { label: 'Friday early finish', kind: 'return', depart_time: '12:30' }],
    },
  },
];

// Children whose own week differs from their contract's.
const TIMETABLES = [
  {
    child: 'Sophie Hetherington', same_all_week: 0, note: 'College placement, Wednesdays at home',
    days: {
      1: ['09:00', '16:00'], 2: ['09:00', '16:00'], 3: null, 4: ['09:00', '16:00'], 5: ['09:00', '12:30'],
    },
  },
  {
    child: 'Nathan Purvis', same_all_week: 1, start_time: '09:00', finish_time: '15:15',
    note: 'Work experience on a Friday, taken by his family',
    days: { 1: true, 2: true, 3: false, 4: true, 5: false },
  },
  {
    child: 'Oliver Tweddle', same_all_week: 1, start_time: '09:05', finish_time: '15:10',
    note: 'Stays for after-school club on a Friday',
    days: { 1: true, 2: true, 3: true, 4: true, 5: true },
  },
];

// Expiry offsets in days from today. Negative is already expired, small positive is amber.
const DOCUMENTS = [
  ['staff', 'Ian Charlton', ['Driving Licence', 820], ['Driver Badge', 460], ['DBS', 390], ['Safeguarding Training', 300]],
  ['vehicle', 'NL72 KDV', ['Vehicle Insurance', 210], ['MOT', 175], ['Vehicle Licence', 240]],
  ['staff', 'Shabana Iqbal', ['Driving Licence', 940], ['Driver Badge', 22], ['DBS', 410], ['Safeguarding Training', 520]],
  ['vehicle', 'NE71 PXG', ['Vehicle Insurance', 130], ['MOT', 19], ['Vehicle Licence', 280]],
  ['staff', 'Gary Nesbitt', ['Driving Licence', 1120], ['Driver Badge', 350], ['DBS', -9], ['Safeguarding Training', 260]],
  ['vehicle', 'NK69 TYB', ['Vehicle Insurance', 260], ['MOT', 96], ['Vehicle Licence', 190]],
  ['staff', 'Katarzyna Lewandowska', ['Driving Licence', 760], ['Driver Badge', 520], ['DBS', 470], ['Safeguarding Training', 340]],
  ['vehicle', 'NU21 WSM', ['Vehicle Insurance', 180], ['MOT', 145], ['Vehicle Licence', 220]],
  ['staff', 'Derek Almond', ['Driving Licence', 1300], ['Driver Badge', 610], ['DBS', 540], ['Safeguarding Training', 430]],
  ['vehicle', 'GH20 RLC', ['Vehicle Insurance', 240], ['MOT', 12], ['Vehicle Licence', 300]],
  ['staff', 'Funmi Adebayo', ['Driving Licence', 880], ['Driver Badge', 400], ['DBS', 320], ['Safeguarding Training', 27]],
  ['vehicle', 'NL19 HFP', ['Vehicle Insurance', 160], ['MOT', 210], ['Vehicle Licence', 260]],
  ['staff', 'Stuart Kerrigan', ['Driving Licence', 1010], ['Driver Badge', 380], ['DBS', 450], ['Safeguarding Training', 370]],
  ['vehicle', 'ST70 MND', ['Vehicle Insurance', 200], ['MOT', 120], ['Vehicle Licence', 250]],
  ['staff', 'Maureen Docherty', ['Driving Licence', 690], ['Driver Badge', 290], ['DBS', 230], ['Safeguarding Training', 310]],
  ['vehicle', 'NE18 JCB', ['Vehicle Insurance', 140], ['MOT', 88], ['Vehicle Licence', 170]],
  ['staff', 'Tomasz Wojcik', ['Driving Licence', 1180], ['Driver Badge', 480], ['DBS', 500], ['Safeguarding Training', 410]],
  ['vehicle', 'NL23 XKP', ['Vehicle Insurance', 230], ['MOT', 160], ['Vehicle Licence', 210]],
  ['staff', 'Christine Bell', ['DBS', 360], ['Safeguarding Training', 290], ['PA Training', 440]],
  ['staff', 'Amara Nwosu', ['DBS', 16], ['Safeguarding Training', 330], ['PA Training', 380]],
  ['staff', 'Lesley Rutherford', ['DBS', 420], ['Safeguarding Training', 400], ['PA Training', 460]],
  ['staff', 'Joanne Sculthorpe', ['DBS', 540], ['Safeguarding Training', 490]],
  ['staff', 'Paul Teasdale', ['DBS', 310], ['Safeguarding Training', 270], ['PA Training', 350]],
  ['staff', 'Nadia Hussain', ['DBS', 580], ['Safeguarding Training', 520], ['PA Training', 560]],
  ['staff', 'Susan Fenwick', ['DBS', 250], ['Safeguarding Training', 220], ['PA Training', 280]],
  ['staff', 'Michael Oyelaran', ['DBS', 630], ['Safeguarding Training', 590], ['PA Training', 610]],
];

/**
 * Writes the weekly schedules and child timetables. Anything already set up for
 * the same start date is left alone, so this is safe to run more than once.
 */
async function applyPatterns(orgId, contracts, children) {
  let scheduleCount = 0;
  let tripCount = 0;
  let skipped = 0;
  for (const sc of SCHEDULES) {
    if (!contracts[sc.contract]) continue;
    const already = await get(
      'SELECT id FROM contract_schedules WHERE organisation_id = ? AND contract_id = ? AND effective_from = ?',
      [orgId, contracts[sc.contract], TERM_START]);
    if (already) { skipped++; continue; }
    const scheduleId = await insert('contract_schedules',
      { contract_id: contracts[sc.contract], effective_from: TERM_START, note: sc.note, created_by: 'Demo data' },
      ['contract_id', 'effective_from', 'note', 'created_by'], null, orgId);
    scheduleCount++;
    for (const [weekdayNo, trips] of Object.entries(sc.days)) {
      let seq = 0;
      for (const t of trips) {
        seq++;
        const tripId = await insert('contract_trips',
          { schedule_id: scheduleId, weekday: Number(weekdayNo), seq, label: t.label, kind: t.kind, depart_time: t.depart_time },
          ['schedule_id', 'weekday', 'seq', 'label', 'kind', 'depart_time'], null, orgId);
        tripCount++;
        for (const name of t.children || []) {
          if (!children[name]) continue;
          await insert('contract_trip_children', { trip_id: tripId, child_id: children[name] },
            ['trip_id', 'child_id'], null, orgId);
        }
      }
    }
  }

  let timetableCount = 0;
  for (const tt of TIMETABLES) {
    if (!children[tt.child]) continue;
    const already = await get(
      'SELECT id FROM child_timetables WHERE organisation_id = ? AND child_id = ? AND effective_from = ?',
      [orgId, children[tt.child], TERM_START]);
    if (already) { skipped++; continue; }
    const timetableId = await insert('child_timetables', {
      child_id: children[tt.child], effective_from: TERM_START, same_all_week: tt.same_all_week,
      start_time: tt.start_time || null, finish_time: tt.finish_time || null,
      note: tt.note, created_by: 'Demo data',
    }, ['child_id', 'effective_from', 'same_all_week', 'start_time', 'finish_time', 'note', 'created_by'], null, orgId);
    timetableCount++;
    for (const [weekdayNo, value] of Object.entries(tt.days)) {
      const attends = value ? 1 : 0;
      const times = Array.isArray(value) ? value : [null, null];
      await insert('child_timetable_days', {
        timetable_id: timetableId, weekday: Number(weekdayNo), attends,
        start_time: times[0], finish_time: times[1],
      }, ['timetable_id', 'weekday', 'attends', 'start_time', 'finish_time'], null, orgId);
    }
  }

  return { scheduleCount, tripCount, timetableCount, skipped };
}

// ---------------------------------------------------------------- run
async function main() {
  await database.migrate();

  if (LIST || (!NAME && !ORG_ID)) {
    const orgs = await all('SELECT id, name FROM organisations ORDER BY id');
    console.log('\nBusinesses on this system:');
    for (const o of orgs) {
      const c = await get('SELECT (SELECT COUNT(*) FROM children WHERE organisation_id = ?) AS ch, (SELECT COUNT(*) FROM contracts WHERE organisation_id = ?) AS co', [o.id, o.id]);
      const shared = orgs.filter(x => x.name.toLowerCase() === o.name.toLowerCase()).length > 1;
      console.log(`  ${String(o.id).padStart(3)}  ${o.name.padEnd(40)} ${c.ch} children, ${c.co} contracts${shared ? '   (name shared - use --id)' : ''}`);
    }
    console.log('\nFill one with demo data:  npm run demo -- "<business name>"');
    console.log('Or by id:                 npm run demo -- --id <number>');
    console.log('Weekly patterns only:     npm run demo -- --id <number> --patterns\n');
    return;
  }

  const org = ORG_ID
    ? await get('SELECT id, name FROM organisations WHERE id = ?', [ORG_ID])
    : await get('SELECT id, name FROM organisations WHERE LOWER(name) = LOWER(?) ORDER BY id', [NAME]);
  const sameName = ORG_ID ? [] : await all('SELECT id FROM organisations WHERE LOWER(name) = LOWER(?) ORDER BY id', [NAME]);
  if (org && sameName.length > 1) {
    console.error(`\n${sameName.length} businesses are called "${org.name}" (ids ${sameName.map(o => o.id).join(', ')}).`);
    console.error('Say which one with --id <number>. Nothing has been changed.\n');
    process.exitCode = 1;
    return;
  }
  if (!org) {
    console.error(`\nNo business ${ORG_ID ? 'with id ' + ORG_ID : `called "${NAME}"`}. Run with --list to see them.\n`);
    process.exitCode = 1;
    return;
  }
  const orgId = org.id;
  console.log(`\nFilling "${org.name}" with demo data.`);

  if (PATTERNS_ONLY) {
    const contractRows = await all('SELECT id, code FROM contracts WHERE organisation_id = ?', [orgId]);
    const childRows = await all('SELECT id, first_name, last_name FROM children WHERE organisation_id = ?', [orgId]);
    const byCode = Object.fromEntries(contractRows.map(c => [c.code, c.id]));
    const byName = Object.fromEntries(childRows.map(c => [`${c.first_name} ${c.last_name}`, c.id]));
    const r = await applyPatterns(orgId, byCode, byName);
    console.log(`\n  Weekly schedules added: ${r.scheduleCount}  (${r.tripCount} journeys a week)`);
    console.log(`  Child timetables added: ${r.timetableCount}`);
    if (r.skipped) console.log(`  Left alone because they were already set up: ${r.skipped}`);
    console.log('\n  Nothing else was changed.\n');
    return;
  }

  const busy = await get(`SELECT (SELECT COUNT(*) FROM contracts WHERE organisation_id = ?) AS contracts,
     (SELECT COUNT(*) FROM children WHERE organisation_id = ?) AS children`, [orgId, orgId]);
  if ((Number(busy.contracts) || Number(busy.children)) && !REPLACE) {
    console.error(`\nThat business already has ${busy.contracts} contracts and ${busy.children} children.`);
    console.error('Add --replace to clear its records first. Nothing has been changed.\n');
    process.exitCode = 1;
    return;
  }
  if (REPLACE) {
    // Named in dependency order. The weekly patterns would cascade with their
    // contract and child anyway, but clearing them explicitly says so out loud.
    for (const t of ['payroll_run_lines', 'payroll_runs', 'payments', 'exceptions', 'expenses',
      'documents', 'contract_trip_children', 'contract_trips', 'contract_schedules',
      'child_timetable_days', 'child_timetables', 'children', 'contracts', 'vehicles',
      'staff', 'schools', 'councils']) {
      await run(`DELETE FROM ${t} WHERE organisation_id = ?`, [orgId]);
    }
    console.log('  Cleared its existing records. Sign-in accounts were left alone.');
  }

  await setSetting(orgId, 'company_name', org.name);
  await setSetting(orgId, 'amber_days', '30');

  // ---- councils, reusing any the owner already created ----
  const councils = {};
  for (const c of COUNCILS) {
    const short = c.name.replace(/ (City|County)? ?Council$/, '');
    const existing = await get(
      'SELECT id, name FROM councils WHERE organisation_id = ? AND (LOWER(name) = LOWER(?) OR LOWER(name) = LOWER(?))',
      [orgId, c.name, short]);
    if (existing) {
      // Fill in the details on a record that was created with just a name.
      await run('UPDATE councils SET name = ?, contact_name = ?, phone = ?, email = ?, address = ? WHERE id = ? AND organisation_id = ?',
        [c.name, c.contact_name, c.phone, c.email, c.address, existing.id, orgId]);
      councils[c.name] = existing.id;
    } else {
      councils[c.name] = await insert('councils', c, ['name', 'contact_name', 'phone', 'email', 'address'], null, orgId);
    }
  }

  const schools = {};
  for (const s of SCHOOLS) {
    schools[s.name] = await insert('schools', s,
      ['name', 'address', 'postcode', 'phone', 'contact_name', 'email', 'open_time', 'close_time', 'notes'], null, orgId);
  }

  // ---- staff, keeping anyone the owner already added ----
  const STAFF_COLS = ['type', 'first_name', 'last_name', 'address', 'postcode', 'phone', 'email',
    'emergency_contact_name', 'emergency_contact_phone', 'status', 'licensing_authority', 'badge_number',
    'dbs_number', 'default_day_rate', 'availability', 'preferred_areas', 'start_date', 'notes'];
  const staff = {};
  const existingStaff = await all('SELECT id, first_name, last_name, type FROM staff WHERE organisation_id = ?', [orgId]);
  for (const s of existingStaff) staff[`${s.first_name} ${s.last_name}`] = s.id;
  if (existingStaff.length) {
    console.log(`  Keeping ${existingStaff.length} staff member(s) you had already added.`);
  }
  for (const s of DRIVERS) {
    const key = `${s.first_name} ${s.last_name}`;
    if (!staff[key]) staff[key] = await insert('staff', { ...s, type: 'driver' }, STAFF_COLS, null, orgId);
  }
  for (const s of PAS) {
    const key = `${s.first_name} ${s.last_name}`;
    if (!staff[key]) staff[key] = await insert('staff', { ...s, type: 'pa' }, STAFF_COLS, null, orgId);
  }

  // A driver the owner created is given a contract of their own, so they appear in the demo.
  const ownDriver = existingStaff.find(s => s.type === 'driver');
  const ownDriverKey = ownDriver ? `${ownDriver.first_name} ${ownDriver.last_name}` : null;
  if (ownDriver) {
    await run("UPDATE staff SET status = 'active' WHERE id = ? AND organisation_id = ?", [ownDriver.id, orgId]);
  }

  const vehicles = {};
  for (const v of VEHICLES) {
    vehicles[v.registration] = await insert('vehicles', { ...v, driver_id: staff[v.driver] || null },
      ['driver_id', 'registration', 'make', 'model', 'seats', 'wheelchair_accessible', 'colour'], null, orgId);
  }
  if (ownDriver) {
    vehicles['NE24 OWN'] = await insert('vehicles',
      { driver_id: ownDriver.id, registration: 'NE24 OWN', make: 'Ford', model: 'Tourneo Custom', seats: 8, wheelchair_accessible: 1, colour: 'White' },
      ['driver_id', 'registration', 'make', 'model', 'seats', 'wheelchair_accessible', 'colour'], null, orgId);
  }

  const contracts = {};
  for (const c of CONTRACTS) {
    const driverKey = c.driver === 'MOHAMMED' ? ownDriverKey : c.driver;
    contracts[c.code] = await insert('contracts', {
      code: c.code, name: c.name, council_id: councils[c.council], council_ref: c.council_ref,
      school_id: schools[c.school],
      driver_id: driverKey ? staff[driverKey] : null,
      pa_id: c.pa ? staff[c.pa] : null,
      vehicle_id: c.vehicle ? vehicles[c.vehicle] : (c.driver === 'MOHAMMED' && ownDriver ? vehicles['NE24 OWN'] : null),
      requires_pa: c.requires_pa === undefined ? 1 : c.requires_pa,
      status: c.status || 'active',
      start_date: c.start_offset ? d(c.start_offset) : TERM_START,
      end_date: TERM_END,
      days_of_week: '1,2,3,4,5',
      am_pickup_time: c.am_pickup_time, am_arrival_time: c.am_arrival_time,
      pm_finish_time: c.pm_finish_time, pm_dropoff_time: c.pm_dropoff_time,
      route_info: c.route_info, income_per_day: c.income_per_day, income_basis: 'per_journey',
      driver_pay_per_day: c.driver_pay_per_day, pa_pay_per_day: c.pa_pay_per_day, pay_basis: 'per_journey',
      other_costs_per_day: c.other_costs_per_day, notes: c.notes,
    }, ['code', 'name', 'council_id', 'council_ref', 'school_id', 'driver_id', 'pa_id', 'vehicle_id', 'requires_pa',
      'status', 'start_date', 'end_date', 'days_of_week', 'am_pickup_time', 'am_arrival_time', 'pm_finish_time',
      'pm_dropoff_time', 'route_info', 'income_per_day', 'income_basis', 'driver_pay_per_day', 'pa_pay_per_day',
      'pay_basis', 'other_costs_per_day', 'notes'], null, orgId);
  }

  const children = {};
  for (const c of CHILDREN) {
    const contractId = contracts[c.contract];
    const schoolId = (await get('SELECT school_id FROM contracts WHERE organisation_id = ? AND id = ?', [orgId, contractId])).school_id;
    const row = { ...c, contract_id: contractId, school_id: schoolId, status: 'active' };
    row.arrival_time = CONTRACTS.find(x => x.code === c.contract).am_arrival_time;
    row.finish_time = CONTRACTS.find(x => x.code === c.contract).pm_finish_time;
    children[`${c.first_name} ${c.last_name}`] = await insert('children', row,
      ['first_name', 'last_name', 'dob', 'address', 'postcode', 'parent_name', 'parent_phone',
        'emergency_contact_name', 'emergency_contact_phone', 'school_id', 'contract_id', 'council_ref',
        'pickup_time', 'arrival_time', 'finish_time', 'dropoff_time', 'medical_info', 'sen_needs', 'conditions',
        'mobility', 'wheelchair', 'behaviour', 'communication', 'allergies', 'safeguarding_info', 'risk_info',
        'notes', 'status'], null, orgId);
  }

  // ---- weekly patterns ----
  const patterns = await applyPatterns(orgId, contracts, children);
  const { scheduleCount, tripCount, timetableCount } = patterns;

  let docCount = 0;
  // A driver the owner created gets a full, valid set, so their own record reads
  // green in the demo. Amber and red are shown by other staff.
  const extraDocs = [...DOCUMENTS];
  if (ownDriverKey) {
    extraDocs.push(['staff', ownDriverKey,
      ['Driving Licence', 900], ['Driver Badge', 540], ['DBS', 480], ['Safeguarding Training', 420]]);
    if (vehicles['NE24 OWN']) {
      extraDocs.push(['vehicle', 'NE24 OWN', ['Vehicle Insurance', 250], ['MOT', 200], ['Vehicle Licence', 270]]);
    }
  }
  for (const [entityType, key, ...docs] of extraDocs) {
    const entityId = entityType === 'staff' ? staff[key] : vehicles[key];
    if (!entityId) continue;
    for (const [docType, offset] of docs) {
      await insert('documents', {
        entity_type: entityType, entity_id: entityId, doc_type: docType,
        issue_date: cal.addDays(d(offset), -365), expiry_date: d(offset), status: 'valid',
        uploaded_by: 'Demo data', notes: 'Demo record, no file attached',
      }, ['entity_type', 'entity_id', 'doc_type', 'issue_date', 'expiry_date', 'status', 'uploaded_by', 'notes'], null, orgId);
      docCount++;
    }
  }

  // ---- a few weeks of exceptions, showing every mechanism ----
  const EX_COLS = ['date', 'type', 'leg', 'contract_id', 'school_id', 'child_id', 'role', 'staff_id',
    'cover_staff_id', 'cover_pay', 'paid_immediately', 'amount', 'note', 'created_by'];
  const exceptions = [
    { date: weekday(9), type: 'child_absence', leg: 'DAY', contract: 'BEWICK 1', child: 'Jacob Riddell', note: 'Parent rang, unwell' },
    { date: weekday(8), type: 'staff_absence', leg: 'DAY', contract: 'HADRIAN AM/PM 1', role: 'driver', cover: 'Tomasz Wojcik', cover_pay: 80, paid_immediately: 1, note: 'Ian at a hospital appointment. Tomasz covered and was paid the same day in cash.' },
    { date: weekday(7), type: 'school_closed', leg: 'DAY', school: 'Woodlawn School', note: 'Staff training day' },
    { date: weekday(6), type: 'child_absence', leg: 'PM', contract: 'BEACON HILL 1', child: 'Ethan Stobbart', note: 'Collected from school by mum' },
    { date: weekday(5), type: 'staff_absence', leg: 'AM', contract: 'DRYDEN 1', role: 'pa', cover: 'Susan Fenwick', cover_pay: 22, paid_immediately: 0, note: 'Nadia delayed by traffic on the A1. Susan covered the AM run only.' },
    { date: weekday(4), type: 'journey_cancelled', leg: 'PM', contract: 'GIBSIDE 1', note: 'Severe weather. School closed early and parents collected.' },
    { date: weekday(3), type: 'child_absence', leg: 'DAY', contract: 'BAMBURGH 1', child: 'Erin Kirkbride', note: 'Family holiday, agreed with school' },
    { date: weekday(2), type: 'staff_absence', leg: 'DAY', contract: 'WOODLAWN 2', role: 'driver', cover: null, note: 'Maureen off sick, no cover available. The run did not operate.' },
    { date: weekday(1), type: 'child_absence', leg: 'AM', contract: 'HADRIAN AM/PM 2', child: 'Haris Mahmood', note: 'Late, taken in by parent' },
    { date: TODAY, type: 'staff_absence', leg: 'DAY', contract: 'BEACON HILL 1', role: 'pa', cover: null, note: 'Lesley off sick. Cover still required for this afternoon.' },
    { date: TODAY, type: 'child_absence', leg: 'DAY', contract: 'BEWICK 1', child: 'Amelia Coyne', note: 'Hospital appointment' },
    { date: d(1), type: 'staff_absence', leg: 'DAY', contract: 'GIBSIDE 1', role: 'driver', cover: 'Maureen Docherty', cover_pay: 70, paid_immediately: 0, note: 'Derek on pre-booked leave. Maureen allocated from the pool.' },
    { date: d(2), type: 'note', leg: 'DAY', contract: 'HADRIAN AM/PM 1', note: 'Roadworks on the West Road all week. Allow ten minutes extra.' },
  ];
  for (const e of exceptions) {
    const contractId = e.contract ? contracts[e.contract] : null;
    let staffId = null;
    if (e.type === 'staff_absence' && contractId) {
      const c = await get('SELECT driver_id, pa_id FROM contracts WHERE organisation_id = ? AND id = ?', [orgId, contractId]);
      staffId = e.role === 'driver' ? c.driver_id : c.pa_id;
    }
    const id = await insert('exceptions', {
      date: e.date, type: e.type, leg: e.leg,
      contract_id: e.school ? null : contractId,
      school_id: e.school ? schools[e.school] : null,
      child_id: e.child ? children[e.child] : null,
      role: e.role || null, staff_id: staffId,
      cover_staff_id: e.cover ? staff[e.cover] : null,
      cover_pay: e.cover ? e.cover_pay : null,
      paid_immediately: e.paid_immediately || 0,
      note: e.note, created_by: 'Demo data',
    }, EX_COLS, null, orgId);

    if (e.paid_immediately && e.cover) {
      await insert('payments', {
        staff_id: staff[e.cover], work_date: e.date, paid_date: e.date, amount: e.cover_pay,
        source: 'cover_immediate', exception_id: id, note: 'Cover paid immediately', created_by: 'Demo data',
      }, ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'note', 'created_by'], null, orgId);
    }
  }

  for (const x of [
    { date: weekday(6), contract: 'BEACON HILL 1', category: 'Fuel', amount: 52.4, description: 'Additional fuel, diversion via the Tyne Tunnel' },
    { date: weekday(11), contract: 'BAMBURGH 1', category: 'Vehicle repair', amount: 185, description: 'Wheelchair ramp hinge replacement' },
    { date: weekday(4), contract: 'GIBSIDE 1', category: 'Parking / tolls', amount: 18, description: 'Tyne Tunnel crossings during the diversion' },
  ]) {
    await insert('expenses', { ...x, contract_id: contracts[x.contract], created_by: 'Demo data' },
      ['date', 'contract_id', 'category', 'amount', 'description', 'created_by'], null, orgId);
  }

  const summary = await get(`SELECT
      (SELECT COUNT(*) FROM councils   WHERE organisation_id = ?) AS councils,
      (SELECT COUNT(*) FROM schools    WHERE organisation_id = ?) AS schools,
      (SELECT COUNT(*) FROM staff      WHERE organisation_id = ?) AS staff,
      (SELECT COUNT(*) FROM vehicles   WHERE organisation_id = ?) AS vehicles,
      (SELECT COUNT(*) FROM contracts  WHERE organisation_id = ?) AS contracts,
      (SELECT COUNT(*) FROM children   WHERE organisation_id = ?) AS children,
      (SELECT COUNT(*) FROM documents  WHERE organisation_id = ?) AS documents,
      (SELECT COUNT(*) FROM exceptions WHERE organisation_id = ?) AS exceptions`, Array(8).fill(orgId));

  console.log('');
  console.log(`  Councils   ${summary.councils}`);
  console.log(`  Schools    ${summary.schools}`);
  console.log(`  Staff      ${summary.staff}   (drivers and passenger assistants)`);
  console.log(`  Vehicles   ${summary.vehicles}`);
  console.log(`  Contracts  ${summary.contracts}`);
  console.log(`  Children   ${summary.children}`);
  console.log(`  Documents  ${docCount}`);
  console.log(`  Weekly schedules ${scheduleCount}  (${tripCount} journeys a week, including a three-journey Friday)`);
  console.log(`  Child timetables ${timetableCount}  (including college days and days not attended)`);
  console.log(`  Exceptions ${summary.exceptions}  across the last fortnight and the days ahead`);
  console.log('');
  console.log(`  "${org.name}" is ready to show. Sign in as usual.`);
  console.log('  No other business on this system was touched.');
  console.log('');
}

main()
  .then(() => database.close())
  .catch(async e => {
    console.error('\nCould not fill the business:', e.message);
    try { await database.close(); } catch (_) {}
    process.exit(1);
  });
