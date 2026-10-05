const test = require("node:test");
const assert = require("node:assert/strict");
const { buildConsentLists, paginateConsentMembers } = require("../src/consent-report");

function makeMembers(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));
}

test("수신 동의 현황은 봇을 제외하고 이름순으로 정확히 분류한다", () => {
  const members = [
    { id: "2", displayName: "나래", user: { bot: false }, roles: { cache: new Map() } },
    { id: "1", displayName: "가람", user: { bot: false }, roles: { cache: new Map([["consent", {}]]) } },
    { id: "3", displayName: "공지봇", user: { bot: true }, roles: { cache: new Map() } },
  ];

  const result = buildConsentLists(members, "consent");

  assert.deepEqual(result.humans.map((member) => member.id), ["1", "2"]);
  assert.deepEqual(result.optedIn.map((member) => member.id), ["1"]);
  assert.deepEqual(result.optedOut.map((member) => member.id), ["2"]);
});

test("동의와 미동의 명단을 각 페이지 크기에 맞춰 함께 나눈다", () => {
  const optedIn = makeMembers(21, "in");
  const optedOut = makeMembers(11, "out");

  const pages = paginateConsentMembers(optedIn, optedOut, 10);

  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => page.optedIn.length), [10, 10, 1]);
  assert.deepEqual(pages.map((page) => page.optedOut.length), [10, 1, 0]);
  assert.equal(pages[2].optedIn[0].id, "in-20");
});

test("양쪽 명단이 비어 있어도 요약 표시용 페이지를 하나 만든다", () => {
  assert.deepEqual(paginateConsentMembers([], []), [{ optedIn: [], optedOut: [] }]);
});

test("페이지 크기가 양의 정수가 아니면 거부한다", () => {
  assert.throws(() => paginateConsentMembers([], [], 0), RangeError);
  assert.throws(() => paginateConsentMembers([], [], 1.5), RangeError);
});
