require("dotenv").config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  ActivityType,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const { getAbsentMembers, getPresentMembers, splitMentions } = require("./attendance");
const { buildConsentLists, paginateConsentMembers } = require("./consent-report");
const {
  clearAllowedRoleIds,
  canUseRestrictedCommand,
  getAllowedRoleIds,
  loadAccessRoles,
  setAllowedRoleIds,
} = require("./access-control");

if (!process.env.DISCORD_TOKEN?.trim()) {
  throw new Error("DISCORD_TOKEN이 없습니다. .env 파일에 Discord 봇 토큰을 설정해 주세요.");
}
if (process.env.DISCORD_CLIENT_ID
    && !/^\d{17,20}$/.test(process.env.DISCORD_CLIENT_ID.trim())) {
  throw new Error("DISCORD_CLIENT_ID 형식이 올바르지 않습니다. Discord Application ID를 확인해 주세요.");
}
const ANNOUNCEMENT_ROLE_NAME = "사이키봇 공지 수신";
const ANNOUNCEMENT_COOLDOWN_MS = 60 * 1000;
const ANNOUNCEMENT_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const ANNOUNCEMENT_CONCURRENCY = 5;
const pendingAnnouncements = new Map();
const pendingConsentReports = new Map();
const announcementRoleProvisioning = new Map();
const guildAnnouncementLocks = new Set();
const guildAnnouncementCooldowns = new Map();
const KNOWN_COMMANDS = new Set(["회의불참자목록", "사이키도움말", "공지수신", "공지수신현황", "dm전송", "봇사용역할설정"]);
const MAX_PENDING_ACTIONS = 100;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

function isAdministrator(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function canUseBotCommands(interaction) {
  const allowedRoleIds = getAllowedRoleIds(interaction.guildId);
  if (!allowedRoleIds.length) return false;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return canUseRestrictedCommand(
    isAdministrator(interaction),
    [...member.roles.cache.keys()],
    allowedRoleIds,
  );
}

async function createOrFetchAnnouncementRole(guild) {
  const roles = await guild.roles.fetch();
  const matchingRoles = roles.filter((role) => role.name === ANNOUNCEMENT_ROLE_NAME);
  if (matchingRoles.size > 1) {
    throw new Error(`"${ANNOUNCEMENT_ROLE_NAME}" 역할이 여러 개입니다. 중복 역할을 정리해 주세요.`);
  }
  let role = matchingRoles.first();
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!role) {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error(`공지 수신 역할을 자동 생성하려면 봇에 역할 관리 권한이 필요합니다 (${ANNOUNCEMENT_ROLE_NAME}).`);
    }
    role = await guild.roles.create({
      name: ANNOUNCEMENT_ROLE_NAME,
      permissions: [],
      reason: "공지 DM 수신 동의를 기록하기 위한 역할 자동 생성",
    });
  }
  if (role.managed) {
    throw new Error("공지 수신 역할로 연동 앱 관리 역할은 사용할 수 없습니다.");
  }
  if (role.permissions.any([
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
  ])) {
    throw new Error("공지 수신 역할에 관리자 권한이 포함되어 있습니다. 권한이 없는 역할을 설정해 주세요.");
  }

  const botHighestRole = botMember.roles.highest;
  if (role.position >= botHighestRole.position) {
    const targetPosition = botHighestRole.position - 1;
    if (targetPosition < 1) {
      throw new Error("Discord 역할 순서상 공지 수신 역할을 봇 역할 아래에 자동 배치할 수 없습니다. 서버 관리자가 봇 역할을 위로 올려 주세요.");
    }
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error("공지 수신 역할을 봇 역할 아래에 배치하려면 봇에 역할 관리 권한이 필요합니다.");
    }
    try {
      role = await role.setPosition(targetPosition, {
        reason: "공지 수신 동의 역할을 봇이 관리할 수 있도록 자동 배치",
      });
    } catch (error) {
      console.error(`공지 수신 역할 자동 배치 실패 (${guild.id}):`, error);
      throw new Error("공지 수신 역할을 봇 역할 아래로 자동 이동하지 못했습니다. 봇의 역할 관리 권한과 역할 위치를 확인해 주세요.");
    }
  }
  if (role.position >= botHighestRole.position) {
    throw new Error("공지 수신 역할을 봇 역할 아래에 자동 배치하지 못했습니다. 서버 설정의 역할 순서를 확인해 주세요.");
  }
  return role;
}

async function fetchAnnouncementRole(guild) {
  const pending = announcementRoleProvisioning.get(guild.id);
  if (pending) return pending;

  const provisioning = createOrFetchAnnouncementRole(guild);
  announcementRoleProvisioning.set(guild.id, provisioning);
  try {
    return await provisioning;
  } finally {
    if (announcementRoleProvisioning.get(guild.id) === provisioning) {
      announcementRoleProvisioning.delete(guild.id);
    }
  }
}

function createAnnouncementProgressEmbed({ total, delivered, failed, skipped, complete = false }) {
  const processed = delivered + failed.length + skipped;
  const remaining = Math.max(0, total - processed);
  const percentage = total === 0 ? 100 : Math.floor((processed / total) * 100);

  return new EmbedBuilder()
    .setColor(complete ? (failed.length ? 0xe6a23c : 0x36b37e) : 0x7c5cff)
    .setTitle(complete ? "DM 공지 발송 결과" : "DM 공지 발송 중")
    .setDescription(`진행률 **${percentage}%** · ${processed}/${total}명 처리\n성공 **${delivered}명** · 실패 **${failed.length}명** · 건너뜀 **${skipped}명**${complete ? "" : ` · 대기 **${remaining}명**`}`)
    .setTimestamp();
}

function validateMeetingOptions(interaction) {
  const voiceChannel = interaction.options.getChannel("회의음성방");
  const role = interaction.options.getRole("회의대상역할");

  if (!voiceChannel || !voiceChannel.isVoiceBased()) {
    return { error: "회의 음성 채널을 선택해 주세요." };
  }

  if (role.guild.id !== interaction.guildId) {
    return { error: "이 서버의 역할만 선택할 수 있습니다." };
  }
  if (role.id === interaction.guildId) {
    return { error: "@everyone 역할은 회의 대상 역할로 사용할 수 없습니다." };
  }

  return { voiceChannel, role };
}

async function fetchGuildMembers(guild) {
  try {
    const membersById = new Map();
    let after;
    while (true) {
      const members = await guild.members.list({ limit: 1000, after });
      if (members.size === 0) break;

      for (const [id, member] of members) membersById.set(id, member);
      after = members.last().id;
      if (members.size < 1000) break;
    }
    return [...membersById.values()];
  } catch (error) {
    console.error(`서버 멤버를 가져오지 못했습니다 (${guild.id}):`, error);
    throw new Error("서버 멤버 목록을 가져오지 못했습니다. 봇의 Server Members Intent와 Discord API 연결을 확인해 주세요.");
  }
}

async function reportAttendance(interaction, presentMembers, absentMembers) {
  const sections = [
    { title: "불참", members: absentMembers },
    { title: "참여", members: presentMembers },
  ];
  const messages = sections.flatMap(({ title, members }) => {
    const chunks = splitMentions(members);
    if (chunks.length === 0) {
      return [{ content: `${title} 인원 0명:\n없음`, userIds: [] }];
    }

    return chunks.map((chunk, index) => ({
      content: `${title} 인원 ${members.length}명${index > 0 ? " (계속)" : ""}:\n${chunk.content}`,
      userIds: chunk.userIds,
    }));
  });

  const [first, ...rest] = messages;
  await interaction.editReply({
    content: first.content,
    allowedMentions: { users: first.userIds },
  });

  for (const message of rest) {
    await interaction.followUp({
      content: message.content,
      allowedMentions: { users: message.userIds },
    });
  }
}

async function handleAttendanceCheck(interaction) {
  const options = validateMeetingOptions(interaction);
  if (options.error) {
    await interaction.editReply({ content: options.error });
    return;
  }

  const guildMembers = await fetchGuildMembers(interaction.guild);
  const roleMembers = guildMembers.filter((member) => member.roles.cache.has(options.role.id));
  const presentMembers = getPresentMembers(options.role, options.voiceChannel, roleMembers);
  const absentMembers = getAbsentMembers(options.role, options.voiceChannel, roleMembers);
  await reportAttendance(interaction, presentMembers, absentMembers);
}

async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x7c5cff)
    .setTitle("사이키봇 사용 안내")
    .setDescription("회의 출석을 확인하고, 선택한 공지 수신 역할 멤버에게 DM 공지를 보냅니다.")
    .addFields(
      {
        name: "회의 불참자 목록",
        value: "봇 사용 허용 역할 보유자가 `/회의불참자목록`에서 음성 채널과 대상 역할을 선택해 실행합니다. 해당 음성방에 없는 멤버를 멘션합니다.",
      },
      {
        name: "DM 공지 수신",
        value: "`/공지수신 설정:동의`로 직접 수신 동의하고, 원하지 않으면 `설정:철회`로 언제든 취소하세요. 동의한 멤버에게만 공지를 보냅니다.",
      },
      {
        name: "DM 공지",
        value: "봇 사용 허용 역할 보유자가 `/dm전송`에서 공지 내용을 입력하고 미리보기에서 전송을 확인합니다. 수신 동의 역할이 있는 멤버에게만 DM을 보냅니다.",
      },
      {
        name: "공지 수신 현황",
        value: "봇 사용 허용 역할 보유자는 `/공지수신현황`에서 동의·미동의 인원 수와 명단을 확인할 수 있습니다. 여러 페이지는 버튼으로 이동합니다.",
      },
      {
        name: "명령어 사용 권한",
        value: "관리자가 `/봇사용역할설정`에서 지정한 역할 보유자만 `/공지수신` 외 명령어를 사용할 수 있습니다. 역할 설정은 관리자 전용입니다.",
      },
    )
    .setFooter({ text: "사이키봇 · 안전한 회의와 공지" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleAnnouncementConsent(interaction) {
  const setting = interaction.options.getString("설정", true);
  if (setting !== "agree" && setting !== "withdraw") {
    await interaction.editReply({
      content: "공지 수신 설정을 선택해 주세요.",
    });
    return;
  }

  const role = await fetchAnnouncementRole(interaction.guild);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (setting === "agree") {
    if (member.roles.cache.has(role.id)) {
      await interaction.editReply({ content: "이미 공지 DM 수신에 동의한 상태입니다." });
      return;
    }
    await member.roles.add(role, "사용자가 /공지수신 명령어로 DM 공지 수신에 동의함");
    await interaction.editReply({
      content: "공지 DM 수신에 동의했습니다. 원하지 않을 때는 `/공지수신 설정:철회`로 언제든 취소할 수 있습니다.",
    });
    return;
  }

  if (!member.roles.cache.has(role.id)) {
    await interaction.editReply({ content: "현재 공지 DM 수신에 동의한 상태가 아닙니다." });
    return;
  }
  await member.roles.remove(role, "사용자가 /공지수신 명령어로 DM 공지 수신 동의를 철회함");
  await interaction.editReply({
    content: "공지 DM 수신 동의를 철회했습니다. 이후 공지 DM 대상에서 제외됩니다.",
  });
}

async function handleCommandRoleSettings(interaction) {
  if (!isAdministrator(interaction)) {
    await interaction.editReply({ content: "이 설정 명령어는 서버 관리자만 사용할 수 있습니다." });
    return;
  }

  const clear = interaction.options.getBoolean("초기화") ?? false;
  const selectedRoles = [...new Map(Array.from({ length: 10 }, (_, index) => (
    interaction.options.getRole(`역할${index + 1}`)
  )).filter(Boolean).map((role) => [role.id, role])).values()];

  if (clear) {
    if (selectedRoles.length) {
      await interaction.editReply({ content: "초기화와 역할 지정은 동시에 할 수 없습니다." });
      return;
    }
    await clearAllowedRoleIds(interaction.guildId);
    await interaction.editReply({
      content: "봇 사용 허용 역할을 초기화했습니다. 새 역할을 설정할 때까지 `/공지수신`과 관리자 전용 `/봇사용역할설정`만 사용할 수 있습니다.",
    });
    return;
  }

  if (!selectedRoles.length) {
    await interaction.editReply({ content: "역할1부터 역할10 중 하나 이상을 지정하거나 초기화를 선택해 주세요." });
    return;
  }
  if (selectedRoles.some((role) => role.id === interaction.guildId || role.managed)) {
    await interaction.editReply({ content: "@everyone 및 연동 앱 관리 역할은 허용 역할로 지정할 수 없습니다." });
    return;
  }

  const guildRoles = await interaction.guild.roles.fetch();
  if (selectedRoles.some((role) => !guildRoles.has(role.id))) {
    await interaction.editReply({ content: "선택한 역할 중 이 서버에서 찾을 수 없는 역할이 있습니다. 다시 선택해 주세요." });
    return;
  }

  await setAllowedRoleIds(interaction.guildId, selectedRoles.map((role) => role.id));
  await interaction.editReply({
    content: `봇 사용 허용 역할을 ${selectedRoles.length}개 저장했습니다.\n${selectedRoles.map((role) => `<@&${role.id}>`).join(" · ")}\n이 역할 중 하나라도 가진 멤버만 공지수신 외 명령어와 관련 버튼을 사용할 수 있습니다. 관리자도 허용 역할이 없으면 사용할 수 없습니다.`,
    allowedMentions: { parse: [] },
  });
}

function createConsentReportEmbed(guildName, report, pageIndex) {
  const page = report.pages[pageIndex];
  const consentRate = report.total === 0 ? 0 : Math.round((report.optedIn.length / report.total) * 100);
  const formatMembers = (members) => members.length
    ? members.map((member) => {
      const displayName = member.displayName
        .replace(/[\r\n]/g, " ")
        .replace(/([\\_*~`|>])/g, "\\$1")
        .slice(0, 48);
      return `• <@${member.id}> — ${displayName}`;
    }).join("\n")
    : "해당 멤버가 없습니다.";

  return new EmbedBuilder()
    .setColor(0x7c5cff)
    .setTitle("공지 수신 현황")
    .setDescription(`**${guildName}** · 전체 멤버 ${report.total}명\n수신 동의 **${report.optedIn.length}명 (${consentRate}%)** · 미동의 **${report.optedOut.length}명**`)
    .addFields(
      {
        name: `✅ 수신 동의 · ${report.optedIn.length}명`,
        value: formatMembers(page.optedIn),
        inline: true,
      },
      {
        name: `⏳ 미동의 · ${report.optedOut.length}명`,
        value: formatMembers(page.optedOut),
        inline: true,
      },
    )
    .setFooter({ text: `페이지 ${pageIndex + 1}/${report.pages.length} · 사용자 멘션 알림은 전송되지 않습니다.` })
    .setTimestamp();
}

function createConsentReportComponents(nonce, pageIndex, pageCount) {
  if (pageCount <= 1) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`consent-report:page:${nonce}:${pageIndex - 1}`)
      .setLabel("이전")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`consent-report:page:${nonce}:${pageIndex + 1}`)
      .setLabel("다음")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pageIndex === pageCount - 1),
  )];
}

async function handleConsentReport(interaction) {
  const role = await fetchAnnouncementRole(interaction.guild);
  const members = await fetchGuildMembers(interaction.guild);
  const { humans, optedIn, optedOut } = buildConsentLists(members, role.id);
  const pages = paginateConsentMembers(optedIn, optedOut);
  const nonce = interaction.id;
  const report = {
    requesterId: interaction.user.id,
    guildId: interaction.guildId,
    optedIn,
    optedOut,
    total: humans.length,
    pages,
  };

  for (const [key, pending] of pendingConsentReports) {
    if (pending.expiresAt < Date.now()) pendingConsentReports.delete(key);
  }
  while (pendingConsentReports.size >= MAX_PENDING_ACTIONS) {
    pendingConsentReports.delete(pendingConsentReports.keys().next().value);
  }
  pendingConsentReports.set(nonce, { ...report, expiresAt: Date.now() + 5 * 60 * 1000 });
  await interaction.editReply({
    embeds: [createConsentReportEmbed(interaction.guild.name, report, 0)],
    components: createConsentReportComponents(nonce, 0, pages.length),
    allowedMentions: { parse: [] },
  });
}

async function handleConsentReportButton(interaction) {
  const [, , nonce, pageText] = interaction.customId.split(":");
  const report = pendingConsentReports.get(nonce);
  if (!report || report.expiresAt < Date.now()) {
    pendingConsentReports.delete(nonce);
    await interaction.reply({
      content: "현황 페이지가 만료되었습니다. `/공지수신현황`을 다시 실행해 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.guildId !== report.guildId
      || interaction.user.id !== report.requesterId
      || !await canUseBotCommands(interaction)) {
    await interaction.reply({
      content: "이 현황 페이지를 조작할 권한이 없습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const pageIndex = Number(pageText);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= report.pages.length) {
    await interaction.reply({
      content: "올바르지 않은 현황 페이지 요청입니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    embeds: [createConsentReportEmbed(interaction.guild.name, report, pageIndex)],
    components: createConsentReportComponents(nonce, pageIndex, report.pages.length),
    allowedMentions: { parse: [] },
  });
}

async function handleAnnouncement(interaction) {
  const content = interaction.options.getString("내용", true).trim();
  if (!content || content.length > 1500) {
    await interaction.editReply({
      content: "공지 내용은 1~1500자여야 합니다.",
    });
    return;
  }
  const guildId = interaction.guildId;
  const now = Date.now();
  const cooldownUntil = guildAnnouncementCooldowns.get(guildId) ?? 0;
  if (guildAnnouncementLocks.has(guildId) || cooldownUntil > now) {
    const waitSeconds = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
    await interaction.editReply({
      content: `이 서버에서 공지를 처리 중이거나 대기 중입니다. 약 ${waitSeconds}초 후 다시 시도해 주세요.`,
    });
    return;
  }

  try {
    const role = await fetchAnnouncementRole(interaction.guild);
    await fetchGuildMembers(interaction.guild);
    const recipients = [...role.members.values()].filter((member) => !member.user.bot);
    if (recipients.length === 0) {
      await interaction.editReply(`선택한 역할 ${role}을 가진 멤버가 없습니다.`);
      return;
    }

    const nonce = `${interaction.id}-${Date.now()}`;
    for (const [key, action] of pendingAnnouncements) {
      if (action.expiresAt < Date.now()) pendingAnnouncements.delete(key);
    }
    while (pendingAnnouncements.size >= MAX_PENDING_ACTIONS) {
      pendingAnnouncements.delete(pendingAnnouncements.keys().next().value);
    }
    pendingAnnouncements.set(nonce, {
      guildId,
      requesterId: interaction.user.id,
      roleId: role.id,
      content,
      expiresAt: Date.now() + ANNOUNCEMENT_CONFIRMATION_TTL_MS,
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`announcement:send:${nonce}`)
        .setLabel(`${recipients.length}명에게 보내기`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`announcement:cancel:${nonce}`)
        .setLabel("취소")
        .setStyle(ButtonStyle.Secondary),
    );
    const preview = new EmbedBuilder()
      .setColor(0x7c5cff)
      .setTitle("DM 공지 미리보기")
      .setDescription(content)
      .addFields(
        { name: "수신 대상 역할", value: `${role.name} · ${recipients.length}명`, inline: true },
        { name: "안내", value: "선택한 역할을 가진 멤버만 대상입니다. 역할은 DM 수신에 동의한 멤버에게만 부여하세요." },
      )
      .setFooter({ text: "전송하려면 아래 버튼을 눌러 확인하세요." });
    await interaction.editReply({
      embeds: [preview],
      components: [row],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(`공지 발송을 완료하지 못했습니다 (${guildId}):`, error);
    await interaction.editReply(`공지 발송을 완료하지 못했습니다: ${error.message}`);
  }
}

async function handleAnnouncementButton(interaction) {
  const [, actionName, nonce] = interaction.customId.split(":");
  const action = pendingAnnouncements.get(nonce);
  if (!action || action.expiresAt < Date.now()) {
    pendingAnnouncements.delete(nonce);
    await interaction.reply({
      content: "공지 확인 시간이 만료되었습니다. `/dm전송`을 다시 실행해 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.guildId !== action.guildId
      || interaction.user.id !== action.requesterId
      || !await canUseBotCommands(interaction)) {
    await interaction.reply({
      content: "이 공지 확인 버튼을 사용할 권한이 없습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (actionName !== "send" && actionName !== "cancel") {
    await interaction.reply({
      content: "올바르지 않은 공지 확인 요청입니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pendingAnnouncements.delete(nonce);
  if (actionName === "cancel") {
    await interaction.update({ content: "DM 공지를 취소했습니다.", embeds: [], components: [] });
    return;
  }

  const cooldownUntil = guildAnnouncementCooldowns.get(action.guildId) ?? 0;
  if (guildAnnouncementLocks.has(action.guildId) || cooldownUntil > Date.now()) {
    await interaction.update({
      content: "현재 다른 공지를 처리 중이거나 발송 대기 시간입니다. 잠시 후 `/dm전송`을 다시 실행해 주세요.",
      embeds: [],
      components: [],
    });
    return;
  }

  guildAnnouncementLocks.add(action.guildId);
  try {
    await interaction.deferUpdate();
    const role = await interaction.guild.roles.fetch(action.roleId);
    if (!role || role.id === interaction.guildId) throw new Error("선택한 수신 역할을 찾지 못했습니다.");
    await fetchGuildMembers(interaction.guild);

    const recipients = [...role.members.values()].filter((member) => !member.user.bot);
    let nextIndex = 0;
    let delivered = 0;
    let skipped = 0;
    const failed = [];
    const workerCount = Math.min(ANNOUNCEMENT_CONCURRENCY, recipients.length);
    let progressUpdate = Promise.resolve();
    let progressUpdatePending = false;
    let sendingComplete = false;

    const publishProgress = () => {
      if (progressUpdatePending || sendingComplete) return;
      progressUpdatePending = true;
      progressUpdate = progressUpdate
        .then(() => interaction.editReply({
          embeds: [createAnnouncementProgressEmbed({
            total: recipients.length,
            delivered,
            failed,
            skipped,
          })],
          content: "",
          components: [],
          allowedMentions: { parse: [] },
        }))
        .catch((error) => {
          console.error(`공지 발송 진행 상황 표시 실패 (${action.guildId}):`, error);
        })
        .finally(() => {
          progressUpdatePending = false;
        });
    };

    await interaction.editReply({
      embeds: [createAnnouncementProgressEmbed({
        total: recipients.length,
        delivered,
        failed,
        skipped,
      })],
      content: "",
      components: [],
      allowedMentions: { parse: [] },
    });
    const progressTimer = setInterval(publishProgress, 5000);

    async function sendNext() {
      while (nextIndex < recipients.length) {
        const member = recipients[nextIndex];
        nextIndex += 1;
        if (!member.roles.cache.has(role.id)) {
          skipped += 1;
          continue;
        }
        try {
          await member.send({
            content: `안녕하세요 <@${member.id}>님, 사이키봇 공지입니다.\n\n${action.content}`,
            allowedMentions: { parse: [], users: [member.id] },
          });
          delivered += 1;
        } catch (error) {
          console.error(`공지 DM 전송 실패 (${member.id}):`, error);
          failed.push(member.displayName);
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: workerCount }, () => sendNext()));
    } finally {
      clearInterval(progressTimer);
      sendingComplete = true;
      await progressUpdate;
    }

    const resultEmbed = createAnnouncementProgressEmbed({
      total: recipients.length,
      delivered,
      failed,
      skipped,
      complete: true,
    }).addFields(
      {
        name: "발송 결과",
        value: `역할 ${role.name} · 전체 ${recipients.length}명 중 성공 **${delivered}명**, 실패 **${failed.length}명**, 역할 제거 등으로 건너뜀 **${skipped}명**`,
      },
      ...(failed.length
        ? [{
          name: "DM 전송 실패 멤버",
          value: `${failed.slice(0, 20).join(", ")}${failed.length > 20 ? ` 외 ${failed.length - 20}명` : ""}`.slice(0, 1024),
        }]
        : []),
    );
    await interaction.editReply({
      content: "",
      embeds: [resultEmbed],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(`공지 발송을 완료하지 못했습니다 (${action.guildId}):`, error);
    await interaction.editReply({
      content: `공지 발송을 완료하지 못했습니다: ${error.message}`,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
  } finally {
    guildAnnouncementLocks.delete(action.guildId);
    guildAnnouncementCooldowns.set(action.guildId, Date.now() + ANNOUNCEMENT_COOLDOWN_MS);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith("announcement:")) {
      await handleAnnouncementButton(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("consent-report:")) {
      await handleConsentReportButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand() || !interaction.guild) return;

    if (!KNOWN_COMMANDS.has(interaction.commandName)) return;
    await interaction.deferReply({ flags: 0 });
    if (interaction.commandName === "봇사용역할설정" && !isAdministrator(interaction)) {
      await interaction.editReply({
        content: "이 설정 명령어는 서버 관리자만 사용할 수 있습니다.",
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (interaction.commandName !== "공지수신"
        && interaction.commandName !== "봇사용역할설정"
        && !await canUseBotCommands(interaction)) {
      await interaction.editReply({
        content: "이 명령어를 사용할 수 있는 역할이 없거나 해당 역할을 보유하지 않았습니다. 서버 관리자에게 `/봇사용역할설정`을 요청해 주세요.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    switch (interaction.commandName) {
      case "회의불참자목록":
        await handleAttendanceCheck(interaction);
        break;
      case "사이키도움말":
        await handleHelp(interaction);
        break;
      case "공지수신":
        await handleAnnouncementConsent(interaction);
        break;
      case "공지수신현황":
        await handleConsentReport(interaction);
        break;
      case "봇사용역할설정":
        await handleCommandRoleSettings(interaction);
        break;
      case "dm전송":
        await handleAnnouncement(interaction);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error("Discord 상호작용 처리 실패:", error);
    const message = `요청을 처리하지 못했습니다: ${error.message}`;
    if (interaction.deferred) {
      await interaction.editReply({ content: message, embeds: [], components: [] });
    } else if (interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
});

client.once(Events.ClientReady, (readyClient) => {
  readyClient.user.setPresence({
    activities: [{ name: "회의 출석 관리", type: ActivityType.Watching }],
    status: "online",
  });
  console.log(`사이키봇 로그인 완료: ${readyClient.user.tag}`);
  if (process.env.DISCORD_CLIENT_ID) {
    console.log("애플리케이션 ID가 설정되어 있습니다. 슬래시 명령어 등록은 `npm run register`로 진행하세요.");
  } else {
    console.log("봇 로그인은 완료됐습니다. 슬래시 명령어 등록에는 DISCORD_CLIENT_ID 설정 후 `npm run register`가 필요합니다.");
  }
});

client.on(Events.GuildCreate, (guild) => {
  fetchAnnouncementRole(guild)
    .then((role) => {
      console.log(`서버 참가 후 공지 수신 역할 준비 완료: ${guild.name} (${role.id})`);
    })
    .catch((error) => {
      console.error(`서버 참가 후 공지 수신 역할을 자동 준비하지 못했습니다 (${guild.id}):`, error);
    });
});

client.on(Events.Error, (error) => {
  console.error("Discord 클라이언트 오류:", error);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`${signal} 신호를 받아 사이키봇을 종료합니다.`);
    client.destroy();
  });
}

async function startBot() {
  try {
    await loadAccessRoles();
    await client.login(process.env.DISCORD_TOKEN.trim());
  } catch (error) {
    console.error("봇 사용 역할 설정을 불러오거나 Discord 로그인을 완료하지 못했습니다:", error);
    process.exitCode = 1;
  }
}

startBot().catch((error) => {
  console.error("봇 시작 처리에 실패했습니다:", error);
  process.exitCode = 1;
});
