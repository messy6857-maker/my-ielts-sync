const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs"),
  { join, resolve } = require("node:path"),
  { tmpdir } = require("node:os"),
  { spawnSync } = require("node:child_process");
const { compactDeletionData, deletedTarget } = require("../retention");
const { mergeData } = require("../sync-protocol");
const key = (base, id) =>
  `myielts_u_alice_${base}__entry_${id
    .split("")
    .map((c) => c.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("")}`;
const raw = (value, stamp, deleted = false) =>
  JSON.stringify({
    __ielts: 2,
    stamp: [stamp, "writer"],
    ...(deleted ? { deleted: true } : { value }),
  });
test("plain-id deletion indexes are collected by their fallback history identity", () => {
  const k = key("task1_essays_v1", "plain-id"),
    data = compactDeletionData({ [k]: raw(null, 10, true) }, "alice");
  data.myielts_u_alice_collection_retention_v3 = raw(
    { task1_essays_v1: "0000000000000020:zzz" },
    30,
  );
  const result = compactDeletionData(data, "alice");
  assert.equal(result[deletedTarget(k, "alice").key], undefined);
});
test("a newer live value removes its superseded deletion barrier", () => {
  const k = key("progress_v1", "word"),
    data = compactDeletionData({ [k]: raw(null, 10, true) }, "alice"),
    result = compactDeletionData(
      { ...data, [k]: raw({ done: 1, total: 2 }, 20) },
      "alice",
    );
  assert.ok(result[k]);
  assert.equal(result[deletedTarget(k, "alice").key], undefined);
});
test("legacy spelling ignores empty versions and marks undated disagreement for explicit selection", () => {
  const k = key("vocabulary_spell_v2", "chapter|1"),
    seed = (value) =>
      JSON.stringify({ __ielts: 2, stamp: [0, "legacy"], value });
  const result = mergeData(
    { [k]: seed({ text: "", alternatives: ["", "  ", "colour"] }) },
    { [k]: seed("color") },
    "alice",
  );
  assert.deepEqual(JSON.parse(result[k]).value, {
    text: "color",
    alternatives: ["color", "colour"],
    requiresSelection: true,
  });
});
test("HTTPS validation failure reports the already running app separately and returns its documented status", () => {
  const script = readFileSync(
      resolve(__dirname, "../deploy/install.sh"),
      "utf8",
    ),
    body = script.slice(script.indexOf("if ! curl -fsS --retry 10"));
  const temp = mkdtempSync(join(tmpdir(), "ielts-tls-test-"));
  try {
    writeFileSync(join(temp, "curl"), "#!/bin/sh\nexit 60\n", { mode: 0o755 });
    const result = spawnSync("bash", ["-c", body], {
      encoding: "utf8",
      env: { ...process.env, PATH: temp + ":" + process.env.PATH },
    });
    assert.equal(result.status, 2);
    assert.match(
      result.stdout,
      /应用已启动且本机健康检查通过|应用已启动、本机 HTTP 通过|应用已启动且本机健康检查通过|应用已启动/,
    );
    assert.match(result.stdout, /无需重新安装/);
    assert.ok(body.includes("--retry-all-errors"));
    assert.ok(!body.includes("-sk"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
