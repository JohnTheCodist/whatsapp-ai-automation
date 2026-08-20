#!/usr/bin/env node
/**
 * Give an existing pharmacy an owner.
 *
 * WHY THIS EXISTS
 * Every pharmacy in this database was created while DEV_AUTH_BYPASS was on,
 * which serves a fixed pharmacy id without consulting `pharmacy_members`. So
 * the rows exist and nobody owns them — `pharmacy_members` is empty.
 *
 * That is invisible until the moment the bypass is turned off, and then it
 * fails completely: requireAuth authenticates the user fine, finds no
 * membership, and refuses. Every pharmacy — including the live one with real
 * orders, patients and a paired WhatsApp number — becomes unreachable, and
 * nothing in the product can grant access because granting access is itself
 * behind the check that is failing.
 *
 * This is the one-time bridge. Run it once per pharmacy that predates
 * sign-up, before the first deploy with authentication enabled.
 *
 *   node scripts/claim-pharmacy.js <email> ["Pharmacy Name"]
 *
 * With no name it lists what is claimable and exits, which is the safer
 * default for a script that grants access to patient data.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', 'server', '.env'), quiet: true });

const { createClient } = require('@supabase/supabase-js');
const { getSql } = require('../server/services/db');

const [, , email, pharmacyName] = process.argv;

async function main() {
  const sql = getSql();

  if (!email) {
    console.error('Usage: node scripts/claim-pharmacy.js <email> ["Pharmacy Name"]');
    process.exit(1);
  }

  // The user must already exist — created by signing up through the app.
  // Creating one here would mean setting a password from a shell, which is
  // both worse security and a second place accounts can come from.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error(`Could not list users: ${error.message}`);

  const user = data.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
  if (!user) {
    console.error(`No account for ${email}.`);
    if (data.users.length === 0) {
      // The first-run case, and worth spelling out: signing up through the
      // app needs VITE_SUPABASE_ANON_KEY, which is usually not set yet at
      // the point someone runs this — so "sign up first" alone is a loop.
      console.error('\nThere are no accounts at all yet. Create the first one in the');
      console.error('Supabase dashboard — this does not need the app configured:');
      console.error('  Authentication → Users → Add user → enter this email and a password');
      console.error('  (tick "Auto Confirm User" so it can sign in immediately)');
      console.error('\nThen run this command again.');
    } else {
      console.error('Sign up through the app first, then run this again.');
      console.error(`Known accounts: ${data.users.map((u) => u.email).join(', ')}`);
    }
    process.exit(1);
  }

  const claimable = await sql`
    select p.id, p.name, count(m.id)::int as members
    from pharmacies p
    left join pharmacy_members m on m.pharmacy_id = p.id
    group by p.id, p.name
    order by p.name
  `;

  if (!pharmacyName) {
    console.log(`Account found: ${user.email} (${user.id})\n`);
    console.log('Pharmacies:');
    for (const p of claimable) {
      console.log(`  ${p.members === 0 ? '[unclaimed]' : '[owned]    '} ${p.name}`);
    }
    console.log('\nRe-run with the name to claim one, e.g.');
    console.log(`  node scripts/claim-pharmacy.js ${email} "Sterling Pharmacy"`);
    return;
  }

  const target = claimable.find((p) => p.name === pharmacyName);
  if (!target) {
    console.error(`No pharmacy named "${pharmacyName}". Run without a name to see the list.`);
    process.exit(1);
  }

  // Idempotent: re-running must not create a second membership row, and the
  // natural way to use a script like this is to run it twice while unsure
  // whether the first one worked.
  const [existing] = await sql`
    select id, role from pharmacy_members
    where pharmacy_id = ${target.id} and user_id = ${user.id}
  `;
  if (existing) {
    console.log(`Already a member: ${user.email} is ${existing.role} of ${target.name}. Nothing to do.`);
    return;
  }

  const [member] = await sql`
    insert into pharmacy_members (pharmacy_id, user_id, role)
    values (${target.id}, ${user.id}, 'owner')
    returning id, role
  `;

  console.log(`Done. ${user.email} is now ${member.role} of ${target.name}.`);
  console.log(`  pharmacy_id: ${target.id}`);
  if (target.members > 0) {
    console.log(`  Note: this pharmacy already had ${target.members} member(s); one more was added.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Failed:', err.message); process.exit(1); });
