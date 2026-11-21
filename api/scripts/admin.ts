// Admin CLI (DESIGN.md §3.3). TODO(WP3): implement.
//   node scripts/admin.ts create <username>   create the first admin (prompts for a password)
//   node scripts/admin.ts invite [--days 7]    print a new single-use invite code
const [cmd] = process.argv.slice(2);
console.error(`admin ${cmd ?? '(none)'}: not implemented yet (WP3).`);
process.exit(1);
