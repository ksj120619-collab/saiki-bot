function getAbsentMembers(role, voiceChannel, roleMembers = role.members.values()) {
  const presentMemberIds = new Set(voiceChannel.members.keys());

  return [...roleMembers]
    .filter((member) => !member.user.bot && !presentMemberIds.has(member.id))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "ko"));
}

function getPresentMembers(role, voiceChannel, roleMembers = role.members.values()) {
  const presentMemberIds = new Set(voiceChannel.members.keys());

  return [...roleMembers]
    .filter((member) => !member.user.bot && presentMemberIds.has(member.id))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "ko"));
}

function splitMentions(members, maxLength = 1700) {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive integer");
  }

  const chunks = [];
  let current = "";
  let currentIds = [];

  for (const member of members) {
    const mention = `<@${member.id}>`;
    if (mention.length > maxLength) {
      throw new RangeError(`Mention for member ${member.id} exceeds maxLength`);
    }
    const next = current ? `${current} ${mention}` : mention;

    if (next.length > maxLength && current) {
      chunks.push({ content: current, userIds: currentIds });
      current = mention;
      currentIds = [member.id];
    } else {
      current = next;
      currentIds.push(member.id);
    }
  }

  if (current) chunks.push({ content: current, userIds: currentIds });
  return chunks;
}

module.exports = { getAbsentMembers, getPresentMembers, splitMentions };
