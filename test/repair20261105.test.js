const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mergeDataWithReport } = require("../sync-protocol");

const user = "audit";
const key = (base) => `myielts_u_${user}_${base}`;
const raw = (stamp, value, deleted = false) =>
  JSON.stringify({
    __ielts: 2,
    stamp: [stamp, "test"],
    ...(deleted ? { deleted: true } : { value }),
  });
const part = (cursor, updatedAt) => ({ cursor, updatedAt, sentences: {} });

test("dictation merges different Parts and keeps the newest version of the same Part", () => {
  const progress = key("dictation_progress_v1");
  const a = { [progress]: raw(30, { "cam18-test1:part1": part(1, 10) }) };
  const b = {
    [progress]: raw(40, {
      "cam18-test1:part1": part(3, 9),
      "cam18-test1:part2": part(4, 20),
    }),
  };
  for (const [previous, incoming] of [
    [a, b],
    [b, a],
  ]) {
    const result = mergeDataWithReport(previous, incoming, user, true);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(JSON.parse(result.data[progress]).value, {
      "cam18-test1:part1": part(1, 10),
      "cam18-test1:part2": part(4, 20),
    });
  }
});

test("a single archive tombstone does not evict an unrelated live score", () => {
  const speaking = key("aigrade_speaking_v1_p2_other");
  const writing = key("aigrade_v1_legacy");
  const result = mergeDataWithReport(
    { [speaking]: raw(10, { score: 7 }), [writing]: raw(11, { score: 6 }) },
    { [writing]: raw(12, null, true) },
    user,
  );
  assert.ok(result.data[speaking]);
  assert.equal(JSON.parse(result.data[writing]).deleted, true);
  assert.equal(result.data[key("archive_retention_v2")], undefined);
});

test("a previously inflated v1 cutoff cannot sweep a v2 writing result", () => {
  const v2 = key("aigrade_v2_writing");
  const oldCutoff = key("archive_retention_v2");
  const result = mergeDataWithReport(
    {
      [oldCutoff]: raw(50, {
        cutoff: [50, "test", key("aigrade_v1_migrated")],
      }),
    },
    { [v2]: raw(10, { score: 7 }) },
    user,
  );
  assert.deepEqual(result.rejected, []);
  assert.ok(result.data[v2]);
});

test("mixed archive retention remains bounded and a stale device cannot resurrect a trimmed v2 result", () => {
  const payload = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      key((i < 2 ? "aigrade_v2_" : "aigrade_v1_") + i),
      raw(i + 1, { score: 6 }),
    ]),
  );
  const first = mergeDataWithReport({}, payload, user);
  assert.equal(
    Object.keys(first.data).filter((k) => k.includes("_aigrade_")).length,
    30,
  );
  assert.ok(first.data[key("archive_retention_writing_v3")]);
  assert.equal(first.data[key("aigrade_v2_0")], undefined);
  const replay = mergeDataWithReport(first.data, payload, user);
  assert.equal(replay.data[key("aigrade_v2_0")], undefined);
  assert.equal(
    Object.keys(replay.data).filter((k) => k.includes("_aigrade_")).length,
    30,
  );
});
