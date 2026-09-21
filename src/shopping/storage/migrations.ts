import m0011 from '../../../drizzle/migrations/0011_thick_madame_web.sql';
import journal from '../../../drizzle/migrations/meta/_journal.json';

// Only Durable Object schema migrations from the shared Drizzle history belong here.
const migrations: Record<string, string> = { m0011 };

export default {
  journal: {
    entries: journal.entries.filter(
      entry => `m${String(entry.idx).padStart(4, '0')}` in migrations,
    ),
  },
  migrations,
};
