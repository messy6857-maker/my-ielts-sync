const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  compactStatsData,
  expandStatsData,
  mergeWriters,
} = require("../stats-archive");
const { mergeData } = require("../sync-protocol");
const key = (id) =>
  "myielts_u_alice_stats_parts_v2__entry_" +
  Array.from(id, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const raw = (n, version = 10, deleted = false) =>
  JSON.stringify({
    __ielts: 2,
    stamp: [version, "writer"],
    ...(deleted
      ? { deleted: true }
      : {
          value: {
            totals: { vocabulary: { known: n, vague: 0, unknown: 0 } },
            days: {},
          },
        }),
  });
test("late legacy-client replicas never double count or replace a newer archived writer", () => {
  const input = { [key("writer")]: raw(5) };
  const compact = mergeData({}, input, "alice", true);
  assert.deepEqual(expandStatsData(compact, "alice"), input);
  assert.deepEqual(
    mergeData(compact, { [key("writer")]: raw(4, 9) }, "alice", true),
    compact,
  );
  const undone = mergeData(
    compact,
    { [key("writer")]: raw(4, 11) },
    "alice",
    true,
  );
  assert.equal(
    JSON.parse(expandStatsData(undone, "alice")[key("writer")]).value.totals
      .vocabulary.known,
    4,
  );
  const deleted = mergeData(
    undone,
    { [key("writer")]: raw(0, 12, true) },
    "alice",
    true,
  );
  const stale = mergeData(deleted, input, "alice", true);
  assert.equal(
    JSON.parse(expandStatsData(stale, "alice")[key("writer")]).deleted,
    true,
  );
});
test("writer bucket merge is associative, commutative and idempotent across replicas", () => {
  const a = { a: [1, "x", { vocabulary: [1, 0, 0] }] },
    b = { b: [1, "y", { vocabulary: [2, 0, 0] }] },
    c = { a: [2, "x", { vocabulary: [0, 0, 0] }] };
  assert.deepEqual(
    mergeWriters(mergeWriters(a, b), c),
    mergeWriters(a, mergeWriters(b, c)),
  );
  assert.deepEqual(mergeWriters(a, b), mergeWriters(b, a));
  assert.deepEqual(mergeWriters(a, a), mergeWriters({}, a));
});
test("hundreds of compacted writer envelopes expand exactly", () => {
  const input = {};
  for (let i = 0; i < 300; i++) input[key("writer-" + i)] = raw(i, i);
  assert.deepEqual(
    expandStatsData(compactStatsData(input, "alice"), "alice"),
    input,
  );
});
