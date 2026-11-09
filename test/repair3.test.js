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

test("capability-only sync GET reports current formats without returning account data", async () => {
  const result = await request("/sync?capabilities=1");
  assert.equal(result.status, 200);
  assert.equal(result.protocolVersion, 2);
  assert.equal(result.compactStats, true);
  assert.equal(result.compactDeletes, true);
  assert.equal(result.data, null);
});

test("sync endpoints accept new writing and dictation data and advertise the capability", async () => {
  const writing = "myielts_u_alice_aigrade_v2_extended";
  const progress = "myielts_u_alice_dictation_progress_v1";
  const headers = { "x-ielts-compact": "1", "x-ielts-deletes": "1" };
  const first = await request(
    "/sync",
    "PUT",
    {
      protocolVersion: 2,
      data: {
        [writing]: raw({ score: 7 }, 20),
        [progress]: raw(
          { "cam18-test1:part1": { cursor: 1, updatedAt: 20 } },
          20,
        ),
      },
    },
    headers,
  );
  assert.equal(first.status, 200);
  assert.equal(first.studyExtensions, true);
  assert.deepEqual(first.rejected, []);
  const second = await request(
    "/sync",
    "PUT",
    {
      protocolVersion: 2,
      data: {
        [progress]: raw(
          { "cam18-test1:part2": { cursor: 3, updatedAt: 21 } },
          21,
        ),
      },
    },
    headers,
  );
  assert.deepEqual(second.rejected, []);
  const pulled = await request("/sync", "GET", null, headers);
  assert.equal(pulled.studyExtensions, true);
  assert.ok(pulled.data[writing]);
  assert.deepEqual(JSON.parse(pulled.data[progress]).value, {
    "cam18-test1:part1": { cursor: 1, updatedAt: 20 },
    "cam18-test1:part2": { cursor: 3, updatedAt: 21 },
  });
});

test("new progress records sync and compact writes return the writing cutoff", async () => {
  const username = "novrepair";
  const registered = await request("/register", "POST", {
    username,
    password: "local-password",
  });
  const headers = {
    authorization: "Bearer " + registered.token,
    "x-ielts-compact": "1",
    "x-ielts-deletes": "1",
  };
  const own = (base) => `myielts_u_${username}_${base}`;
  const row = own("listening179_done_v1__entry_0031");
  const goal = own("study_daily_goal_v1__entry_0067006f0061006c");
  const speaking = own("aigrade_speaking_v1_p2_old");
  const cutoff = own("archive_retention_writing_v3");
  for (const route of ["/sync", "/sync?capabilities=1"]) {
    const result = await request(route, "GET", undefined, headers);
    assert.equal(result.studyExtensions, true);
    assert.equal(result.studyProgressEntries, true);
  }
  const writing = Array.from({ length: 31 }, (_, i) => [
    own("aigrade_v2_" + i),
    raw({ score: 7 }, i + 2),
  ]);
  const first = await request("/sync", "PUT", {
    protocolVersion: 2,
    data: {
      ...Object.fromEntries(writing.slice(0, 30)),
      [row]: raw({ doneAt: 1 }),
      [goal]: raw({ minutes: 90 }),
      [speaking]: raw({ score: 6 }, 1),
    },
  }, headers);
  assert.deepEqual(first.rejected, []);
  assert.equal(first.data[cutoff], undefined);
  const next = await request("/sync", "PUT", {
    protocolVersion: 2,
    data: Object.fromEntries(writing.slice(30)),
  }, headers);
  assert.equal(next.studyProgressEntries, true);
  assert.ok(next.data[cutoff]);
  const pulled = await request("/sync", "GET", undefined, headers);
  assert.ok(pulled.data[speaking]);
  assert.equal(pulled.data[writing[0][0]], undefined);
  assert.deepEqual(JSON.parse(pulled.data[row]).value, { doneAt: 1 });
  assert.deepEqual(JSON.parse(pulled.data[goal]).value, { minutes: 90 });
});

test("AI chat forwards valid reasoning tiers and omits sampling parameters for reasoning models", async (t) => {
  const dns = require("node:dns");
  t.mock.method(dns.promises, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  const fetchLocal = globalThis.fetch;
  let upstream;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (typeof url === "string" && url.startsWith(base))
      return fetchLocal(url, options);
    upstream = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [] }) };
  });
  async function chat(host, model, reasoningEffort) {
    const result = await request("/ai/chat", "POST", {
      baseUrl: host,
      apiKey: "fake-audit-key",
      model,
      messages: [{ role: "user", content: "ping" }],
      reasoningEffort,
      temperature: 0.3,
    });
    assert.equal(result.status, 200);
    return upstream;
  }
  for (const [effort, expected] of [["low", "low"], ["medium", "high"], ["max", "max"]]) {
    const p = await chat("https://api.deepseek.com", "deepseek-flash", effort);
    assert.equal(p.reasoning_effort, expected);
    assert.equal(p.temperature, undefined);
  }
  const reasoned = await chat("https://api.openai.com/v1", "gpt-5.4", "high");
  assert.equal(reasoned.reasoning_effort, "high");
  assert.equal(reasoned.temperature, undefined);
  const ordinary = await chat("https://api.openai.com/v1", "gpt-4o-mini", "high");
  assert.equal(ordinary.reasoning_effort, undefined);
  assert.equal(ordinary.temperature, 0.3);
});
