const test = require("node:test");
const assert = require("node:assert/strict");
const { getAbsentMembers, getPresentMembers, splitMentions } = require("../src/attendance");

function makeMember(id, displayName, bot = false) {
  return { id, displayName, user: { bot } };
}

test("회의 채널에 없는 대상 역할의 사람만 이름순으로 반환한다", () => {
  const role = {
    members: new Map([
      ["3", makeMember("3", "다람")],
      ["1", makeMember("1", "가람")],
      ["2", makeMember("2", "나봇", true)],
      ["4", makeMember("4", "라온")],
    ]),
  };
  const voiceChannel = { members: new Map([["4", makeMember("4", "라온")]]) };

  assert.deepEqual(
    getAbsentMembers(role, voiceChannel).map((member) => member.id),
    ["1", "3"],
  );
});

test("전체 멤버 목록에서 선택한 역할 보유자를 골라 음성 채널 밖의 멤버를 불참자로 반환한다", () => {
  const role = { id: "target-role", members: new Map() };
  const roleMembers = [
    { ...makeMember("1", "가람"), roles: { cache: new Map([["target-role", {}]]) } },
    { ...makeMember("2", "나람"), roles: { cache: new Map([["other-role", {}]]) } },
    { ...makeMember("3", "다람"), roles: { cache: new Map([["target-role", {}]]) } },
  ].filter((member) => member.roles.cache.has(role.id));
  const voiceChannel = { members: new Map([["1", makeMember("1", "가람")]]) };

  assert.deepEqual(
    getAbsentMembers(role, voiceChannel, roleMembers).map((member) => member.id),
    ["3"],
  );
});

test("회의 채널에 참여한 대상 역할의 사람만 이름순으로 반환한다", () => {
  const role = {
    members: new Map([
      ["3", makeMember("3", "다람")],
      ["1", makeMember("1", "가람")],
      ["2", makeMember("2", "나봇", true)],
      ["4", makeMember("4", "라온")],
    ]),
  };
  const voiceChannel = { members: new Map([["4", makeMember("4", "라온")], ["1", makeMember("1", "가람")]]) };

  assert.deepEqual(
    getPresentMembers(role, voiceChannel).map((member) => member.id),
    ["1", "4"],
  );
});

test("멘션 목록을 길이 제한 안에서 분할하고 허용 대상 ID를 함께 반환한다", () => {
  const members = [
    makeMember("1", "one"),
    makeMember("2", "two"),
    makeMember("3", "three"),
  ];

  const chunks = splitMentions(members, 10);

  assert.deepEqual(chunks.map((chunk) => chunk.content), ["<@1> <@2>", "<@3>"]);
  assert.deepEqual(chunks.map((chunk) => chunk.userIds), [["1", "2"], ["3"]]);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 10));
});

test("빈 불참자 목록은 빈 메시지 목록으로 분할한다", () => {
  assert.deepEqual(splitMentions([]), []);
});

test("잘못된 길이 제한과 제한을 넘는 단일 멘션은 거부한다", () => {
  assert.throws(() => splitMentions([], 0), RangeError);
  assert.throws(() => splitMentions([makeMember("123456", "long")], 5), RangeError);
});
