const REPORT_PAGE_SIZE = 10;

function buildConsentLists(members, roleId) {
  const humans = members
    .filter((member) => !member.user.bot)
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "ko"));
  const optedIn = humans.filter((member) => member.roles.cache.has(roleId));
  const optedInIds = new Set(optedIn.map((member) => member.id));
  const optedOut = humans.filter((member) => !optedInIds.has(member.id));

  return { humans, optedIn, optedOut };
}

function paginateConsentMembers(optedIn, optedOut, pageSize = REPORT_PAGE_SIZE) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer");
  }

  const pageCount = Math.max(
    1,
    Math.ceil(optedIn.length / pageSize),
    Math.ceil(optedOut.length / pageSize),
  );

  return Array.from({ length: pageCount }, (_, index) => ({
    optedIn: optedIn.slice(index * pageSize, (index + 1) * pageSize),
    optedOut: optedOut.slice(index * pageSize, (index + 1) * pageSize),
  }));
}

module.exports = { REPORT_PAGE_SIZE, buildConsentLists, paginateConsentMembers };
