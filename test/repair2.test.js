// Correct-behavior regressions for the self-audit.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ielts-self-audit-"));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = "local-audit-only-secret";
const { app, db } = require("../server");
const { mergeData } = require("../sync-protocol");
const key = (base, id, user = "audituser") =>
  `myielts_u_${user}_${base}__entry_${[...id].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
const raw = (value, deleted = false) =>
  JSON.stringify({
    __ielts: 2,
    stamp: [1, "writer"],
    ...(deleted ? { deleted: true } : { value }),
  });
test("D06 server retention keeps a sole live essay after many newer deletions", () => {
  const old = key("task1_essays_v1", "1700000000000"),
    data = { [old]: raw({ id: "1700000000000", text: "the only essay" }) };
  for (let i = 1; i <= 101; i++)
    data[key("task1_essays_v1", String(1700000000000 + i))] = raw(
      undefined,
      true,
    );
  assert.ok(mergeData(data, {}, "audituser")[old]);
});
test("D13 valid accumulated writer counters compact losslessly and no longer block small writes", async () => {
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const registered = await fetch(base + "/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "audituser",
        password: "local-audit-password",
      }),
    });
    const { token } = await registered.json();
    const uid = db
      .prepare("SELECT id FROM users WHERE username=?")
      .get("audituser").id;
    const data = {};
    let bytes = 2,
      count = 0;
    while (true) {
      const id =
        count.toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000";
      const k = key("stats_parts_v2", id),
        v = raw({
          totals: { vocabulary: { known: 1, vague: 0, unknown: 0 } },
          days: {},
        });
      const size =
        Buffer.byteLength(JSON.stringify(k)) +
        1 +
        Buffer.byteLength(JSON.stringify(v)) +
        (count ? 1 : 0);
      if (bytes + size > 5 * 1024 * 1024 - 1500) break;
      data[k] = v;
      bytes += size;
      count++;
    }
    const stored = JSON.stringify(data);
    assert.equal(Buffer.byteLength(stored), bytes);
    db.prepare(
      "INSERT INTO sync_data(user_id,data,updated_at) VALUES(?,?,?)",
    ).run(uid, stored, Date.now());
    const essay = key("task1_essays_v1", String(Date.now()));
    const body = JSON.stringify({
      protocolVersion: 2,
      data: { [essay]: raw({ id: Date.now(), text: "x".repeat(6000) }) },
    });
    assert.ok(Buffer.byteLength(body) < 10000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(base + "/api/sync", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-ielts-compact": "1",
        },
        body,
      });
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.compactStats, true);
    }
    const unchanged = JSON.parse(
      db.prepare("SELECT data FROM sync_data WHERE user_id=?").get(uid).data,
    );
    assert.ok(unchanged[essay]);
    const { expandStatsData } = require("../stats-archive");
    const expanded = expandStatsData(unchanged, "audituser");
    assert.equal(
      Object.keys(expanded).filter((k) => k.includes("_stats_parts_v2__entry_"))
        .length,
      count,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < bytes / 2);
    let cursor,
      pages = 0,
      pulled = {};
    do {
      const response = await fetch(
        base +
          "/api/sync" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        {
          headers: { authorization: `Bearer ${token}`, "x-ielts-compact": "1" },
        },
      );
      assert.equal(response.status, 200);
      const result = await response.json();
      Object.assign(pulled, result.data);
      cursor = result.nextCursor;
      pages++;
    } while (cursor);
    assert.ok(pages > 1);
    assert.deepEqual(pulled, unchanged);
    const legacy = await (
      await fetch(base + "/api/sync", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    assert.deepEqual(legacy.data, expanded);
    // Pagination detects a changed DB revision instead of mixing two snapshots.
    const initial = await (
      await fetch(base + "/api/sync", {
        headers: { authorization: `Bearer ${token}`, "x-ielts-compact": "1" },
      })
    ).json();
    assert.ok(initial.nextCursor);
    db.prepare(
      "UPDATE sync_data SET updated_at=updated_at+1 WHERE user_id=?",
    ).run(uid);
    const stalePage = await fetch(
      base + "/api/sync?cursor=" + encodeURIComponent(initial.nextCursor),
      { headers: { authorization: `Bearer ${token}`, "x-ielts-compact": "1" } },
    );
    assert.equal(stalePage.status, 409);
    // The 5MiB cap is per request, not the accumulated account size.
    const large = {};
    for (
      let i = 0;
      Buffer.byteLength(JSON.stringify(large)) < 5 * 1024 * 1024;
      i += 500
    ) {
      for (let j = i; j < i + 500; j++)
        large[key("sr_vocabulary_v1", String(j))] = raw({
          repetitions: 1,
          interval: 1,
          ease: 2.5,
          dueAt: Date.now(),
          lapses: 0,
        });
    }
    db.prepare(
      "UPDATE sync_data SET data=?,updated_at=updated_at+1 WHERE user_id=?",
    ).run(JSON.stringify(large), uid);
    const added = key("task2_essays_v1", String(Date.now()));
    const small = await fetch(base + "/api/sync", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-ielts-compact": "1",
      },
      body: JSON.stringify({
        protocolVersion: 2,
        data: { [added]: raw({ id: Date.now(), text: "new durable essay" }) },
      }),
    });
    assert.equal(small.status, 200);
    assert.ok(
      JSON.parse(
        db.prepare("SELECT data FROM sync_data WHERE user_id=?").get(uid).data,
      )[added],
    );
    console.log(
      JSON.stringify({
        D13: {
          retiredWriterParts: count,
          storedBytes: bytes,
          incomingRequestBytes: Buffer.byteLength(body),
          repeatedStatus: 200,
        },
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
