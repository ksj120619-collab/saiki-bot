require("dotenv").config();

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

const required = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`필수 환경 변수가 없습니다: ${missing.join(", ")}`);
}
if (!/^\d{17,20}$/.test(process.env.DISCORD_CLIENT_ID.trim())) {
  throw new Error("DISCORD_CLIENT_ID 형식이 올바르지 않습니다. Application ID를 확인해 주세요.");
}
const guildId = process.argv[2]?.trim() || process.env.DISCORD_GUILD_ID?.trim();
if (guildId && !/^\d{17,20}$/.test(guildId)) {
  throw new Error("DISCORD_GUILD_ID 형식이 올바르지 않습니다. 서버 ID를 확인해 주세요.");
}

const moderatorCommands = [
  new SlashCommandBuilder()
    .setName("회의불참자목록")
    .setDescription("회의 음성방에 오지 않은 대상 역할 멤버를 멘션합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) => option
      .setName("회의음성방")
      .setDescription("출석을 확인할 음성 채널")
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setRequired(true))
    .addRoleOption((option) => option
      .setName("회의대상역할")
      .setDescription("출석을 확인할 대상 역할")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("사이키도움말")
    .setDescription("사이키봇 명령어와 사용 방법을 확인합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("공지수신")
    .setDescription("DM 공지 수신에 동의하거나 동의를 철회합니다.")
    .addStringOption((option) => option
      .setName("설정")
      .setDescription("공지 DM 수신 여부")
      .addChoices(
        { name: "동의", value: "agree" },
        { name: "철회", value: "withdraw" },
      )
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("공지수신현황")
    .setDescription("공지 수신 동의 및 미동의 멤버 현황을 확인합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("봇사용역할설정")
    .setDescription("봇 명령어 사용을 허용할 역할을 최대 10개 설정합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption((option) => option
      .setName("초기화")
      .setDescription("이 서버의 허용 역할 설정을 초기화합니다.")
      .setRequired(false))
    .addRoleOption((option) => option.setName("역할1").setDescription("허용할 역할 1").setRequired(false))
    .addRoleOption((option) => option.setName("역할2").setDescription("허용할 역할 2").setRequired(false))
    .addRoleOption((option) => option.setName("역할3").setDescription("허용할 역할 3").setRequired(false))
    .addRoleOption((option) => option.setName("역할4").setDescription("허용할 역할 4").setRequired(false))
    .addRoleOption((option) => option.setName("역할5").setDescription("허용할 역할 5").setRequired(false))
    .addRoleOption((option) => option.setName("역할6").setDescription("허용할 역할 6").setRequired(false))
    .addRoleOption((option) => option.setName("역할7").setDescription("허용할 역할 7").setRequired(false))
    .addRoleOption((option) => option.setName("역할8").setDescription("허용할 역할 8").setRequired(false))
    .addRoleOption((option) => option.setName("역할9").setDescription("허용할 역할 9").setRequired(false))
    .addRoleOption((option) => option.setName("역할10").setDescription("허용할 역할 10").setRequired(false)),
  new SlashCommandBuilder()
    .setName("dm전송")
    .setDescription("공지 수신에 동의한 멤버에게 DM 공지를 보냅니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
      .setName("내용")
      .setDescription("공지 내용 (최대 1500자)")
      .setMaxLength(1500)
      .setRequired(true)),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN.trim());
const applicationId = process.env.DISCORD_CLIENT_ID.trim();
const commandRoute = guildId
  ? Routes.applicationGuildCommands(applicationId, guildId)
  : Routes.applicationCommands(applicationId);

rest.put(commandRoute, {
  body: moderatorCommands.map((command) => command.toJSON()),
}).then((registeredCommands) => {
  console.log(guildId
    ? `사이키봇 서버별 슬래시 명령어 등록 완료 (${guildId})`
    : "사이키봇 전역 슬래시 명령어 등록 완료");
  for (const command of registeredCommands) {
    const optionNames = (command.options ?? []).map((option) => option.name);
    console.log(`/${command.name}${optionNames.length ? ` 옵션: ${optionNames.join(", ")}` : ""}`);
  }
}).catch((error) => {
  console.error("슬래시 명령어 등록 실패:", error);
  process.exitCode = 1;
});
