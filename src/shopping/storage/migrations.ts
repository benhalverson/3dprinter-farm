import m0011 from '../../../drizzle/migrations/0011_thick_madame_web.sql';
import m0012 from '../../../drizzle/migrations/0012_slippery_domino.sql';
import journal from '../../../drizzle/migrations/meta/_journal.json';

// Only Durable Object schema migrations from the shared Drizzle history belong here.
const migrations: Record<string, string> = { m0011, m0012 };

export default {
  journal: {
    entries: journal.entries.filter(
      entry => `m${String(entry.idx).padStart(4, '0')}` in migrations,
    ),
  },
  migrations,
};
