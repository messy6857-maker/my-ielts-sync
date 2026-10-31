const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ielts-repair3-"));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = "repair3-local-secret";
const { app, db, isPrivateOrReservedIp } = require("../server");
const { mergeData } = require("../sync-protocol");
const {
  compactDeletionData,
  expandDeletionData,
  mergeDeletionEntries,
} = require("../retention");
const key = (base, id) =>
  `myielts_u_alice_${base}__entry_${[...id].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
const raw = (value, stamp = 10, deleted = false) =>
  JSON.stringify({
    __ielts: 2,
    stamp: [stamp, "writer"],
    ...(deleted ? { deleted: true } : { value }),
  });
let server, base, token;
before(async () => {
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  token = (
    await request("/register", "POST", {
      username: "alice",
      password: "local-password",
    })
  ).token;
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function request(route, method = "GET", body, headers = {}) {
  const response = await fetch(base + "/api" + route, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...(await response.json()) };
}
test("Teredo private endpoints and private relays are rejected", () => {
  assert.equal(isPrivateOrReservedIp("2001:0:0808:0808:0:0:f5ff:fffe"), true); // 10.0.0.1
  assert.equal(isPrivateOrReservedIp("2001:0:7f00:0001:0:0:f7f7:f7f7"), true); // private relay
  assert.equal(isPrivateOrReservedIp("2001:0:0808:0808:0:0:f7f7:f7f7"), false); // public endpoints
});
test("legacy spelling seeds union answers instead of silently selecting one device", () => {
  const k = key("vocabulary_spell_v2", "chapter|1"),
    a = {
      [k]: JSON.stringify({
        __ielts: 2,
        stamp: [0, "legacy"],
        value: "colour",
      }),
    },
    b = {
      [k]: JSON.stringify({ __ielts: 2, stamp: [0, "legacy"], value: "color" }),
    };
  const merged = mergeData(a, b, "alice"),
    reverse = mergeData(b, a, "alice");
  assert.deepEqual(merged, reverse);
  assert.deepEqual(JSON.parse(merged[k]).value.alternatives, [
    "color",
    "colour",
  ]);
});
test("non-dated deletion envelopes compact, merge independently, and reject old live copies", () => {
  const k = key("sr_vocabulary_v1", "vocab:1"),
    old = raw({ reps: 1 }, 9),
    deleted = raw(null, 10, true);
  const compact = compactDeletionData({ [k]: deleted }, "alice");
  assert.equal(compact[k], undefined);
  assert.equal(
    JSON.parse(expandDeletionData(compact, "alice")[k]).deleted,
    true,
  );
  assert.equal(mergeData(compact, { [k]: old }, "alice", true)[k], undefined);
  const next = mergeData(compact, { [k]: raw({ reps: 2 }, 11) }, "alice", true);
  assert.equal(JSON.parse(next[k]).value.reps, 2);
  assert.deepEqual(
    mergeDeletionEntries({ "a|1": [1, "x"] }, { "a|2": [2, "y"] }),
    mergeDeletionEntries({ "a|2": [2, "y"] }, { "a|1": [1, "x"] }),
  );
});
test("new compact clients and legacy clients retain the same deletion semantics over HTTP", async () => {
  const k = key("progress_v1", "old"),
    headers = { "x-ielts-compact": "1", "x-ielts-deletes": "1" };
  const first = await request(
    "/sync",
    "PUT",
    { protocolVersion: 2, data: { [k]: raw(null, 20, true) } },
    headers,
  );
  assert.equal(first.status, 200);
  assert.equal(first.compactDeletes, true);
  assert.equal(first.data[k], undefined);
  assert.ok(
    Object.keys(first.data).some((k) =>
      k.includes("_deletion_archive_v3__entry_"),
    ),
  );
  const modern = await request("/sync", "GET", null, headers);
  assert.equal(modern.compactDeletes, true);
  assert.equal(modern.data[k], undefined);
  const legacy = await request("/sync");
  assert.equal(JSON.parse(legacy.data[k]).deleted, true);
  const oldStatsClient = await request("/sync", "GET", null, {
    "x-ielts-compact": "1",
  });
  assert.equal(oldStatsClient.compactDeletes, false);
  assert.equal(JSON.parse(oldStatsClient.data[k]).deleted, true);
  const stale = await request("/sync", "PUT", {
    protocolVersion: 2,
    data: { [k]: raw({ done: 1, total: 2 }, 10) },
  });
  assert.equal(stale.status, 200);
  assert.equal(JSON.parse(stale.data[k]).deleted, true);
});
test("the install copy list contains all six required runtime files", () => {
  const install = fs.readFileSync(
    path.resolve(__dirname, "../deploy/install.sh"),
    "utf8",
  );
  const copy = install
    .split("\n")
    .find((line) => line.startsWith('cp "$SRC_DIR/server.js"'));
  for (const file of [
    "server.js",
    "sync-protocol.js",
    "retention.js",
    "stats-archive.js",
    "package.json",
    "package-lock.json",
  ])
    assert.ok(copy.includes(`"$SRC_DIR/${file}"`));
  assert.ok(!install.includes("curl -sk"));
});

test("legacy clients see spelling strings while modern clients retain conflicting seed versions", async () => {
  const k = key("vocabulary_spell_v2", "chapter|seed"),
    headers = { "x-ielts-compact": "1", "x-ielts-deletes": "1" };
  const first = JSON.stringify({
      __ielts: 2,
      stamp: [0, "legacy"],
      value: "colour",
    }),
    second = JSON.stringify({
      __ielts: 2,
      stamp: [0, "legacy"],
      value: "color",
    });
  await request(
    "/sync",
    "PUT",
    { protocolVersion: 2, data: { [k]: first } },
    headers,
  );
  await request(
    "/sync",
    "PUT",
    { protocolVersion: 2, data: { [k]: second } },
    headers,
  );
  const legacy = await request("/sync");
  assert.equal(typeof JSON.parse(legacy.data[k]).value, "string");
  const modern = await request("/sync", "GET", null, headers);
  assert.deepEqual(JSON.parse(modern.data[k]).value.alternatives, [
    "color",
    "colour",
  ]);
});
