const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  canUseRestrictedCommand,
  createAccessRoleStore,
  hasAnyAllowedRole,
} = require("../src/access-control");

test("허용 역할 설정은 서버별로 저장되고 재시작 후에도 유지된다", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saiki-access-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "command-access.json");
  const guildId = "12345678901234567";
  const roleA = "22345678901234567";
  const roleB = "32345678901234567";
  const first = createAccessRoleStore(file);

  await first.load();
  await first.save(guildId, [roleA, roleB, roleA]);
  assert.deepEqual(first.get(guildId), [roleA, roleB]);

  const restarted = createAccessRoleStore(file);
  await restarted.load();
  assert.deepEqual(restarted.get(guildId), [roleA, roleB]);
  assert.deepEqual(restarted.get("42345678901234567"), []);

  await restarted.clear(guildId);
  const afterClear = createAccessRoleStore(file);
  await afterClear.load();
  assert.deepEqual(afterClear.get(guildId), []);
});

test("잘못된 JSON 설정을 무시하지 않고 오류로 알린다", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saiki-access-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "command-access.json");
  await fs.writeFile(file, "{invalid", "utf8");

  await assert.rejects(createAccessRoleStore(file).load(), /설정 파일을 읽을 수 없습니다/);
});

test("유효하지 않은 역할 ID와 서버 ID 저장을 거부한다", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saiki-access-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createAccessRoleStore(path.join(directory, "command-access.json"));
  await store.load();

  assert.throws(() => store.save("12345678901234567", ["invalid"]), /valid Discord IDs/);
  assert.throws(() => store.save("invalid", ["22345678901234567"]), /valid guild ID/);
});

test("허용 역할 중 하나라도 보유할 때만 일반 명령어 접근을 허용한다", () => {
  assert.equal(hasAnyAllowedRole(["member", "allowed-b"], ["allowed-a", "allowed-b"]), true);
  assert.equal(hasAnyAllowedRole(["administrator"], ["allowed-a"]), false);
  assert.equal(hasAnyAllowedRole(["allowed-a"], []), false);
});

test("공지수신 외 명령어는 관리자 권한과 허용 역할을 모두 요구한다", () => {
  assert.equal(canUseRestrictedCommand(true, ["allowed"], ["allowed"]), true);
  assert.equal(canUseRestrictedCommand(false, ["allowed"], ["allowed"]), false);
  assert.equal(canUseRestrictedCommand(true, ["other"], ["allowed"]), false);
  assert.equal(canUseRestrictedCommand(true, ["allowed"], []), false);
});
