/**
 * Test-only: an in-memory Prisma delegate for route tests (`testApp` models).
 * Equality `where` on scalar fields (a nested filter object such as
 * `{ in: [...] }` matches anything), ids `<prefix><n>`, `createdAt` stamped.
 */

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) =>
    v === null ? row[k] == null : typeof v === 'object' ? true : row[k] === v,
  );

export function memTable(prefix: string, rows: Row[] = []) {
  let seq = rows.length;
  const add = (data: Row) => {
    const row = { createdAt: new Date('2026-10-01T00:00:00.000Z'), ...data, id: data.id ?? `${prefix}${++seq}` };
    rows.push(row);
    return row;
  };
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => add(data),
    createMany: async ({ data }: { data: Row[] }) => ({ count: data.map(add).length }),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('record not found');
      return Object.assign(row, data);
    },
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return row ? Object.assign(row, update) : add(create);
    },
    delete: async ({ where }: { where: Row }) => {
      const i = rows.findIndex((r) => matches(r, where));
      return rows.splice(i, 1)[0];
    },
  };
}
