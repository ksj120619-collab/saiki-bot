const fs = require("node:fs/promises");
const path = require("node:path");

const ACCESS_FILE = path.join(__dirname, "..", "data", "command-access.json");
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function normalizeRoleIds(roleIds) {
  if (!Array.isArray(roleIds)
      || roleIds.some((roleId) => typeof roleId !== "string" || !SNOWFLAKE_PATTERN.test(roleId))) {
    throw new TypeError("Role IDs must be an array of valid Discord IDs.");
  }
  return [...new Set(roleIds)];
}

function hasAnyAllowedRole(memberRoleIds, allowedRoleIds) {
  const memberRoles = new Set(memberRoleIds);
  return allowedRoleIds.some((roleId) => memberRoles.has(roleId));
}

function canUseRestrictedCommand(isAdmin, memberRoleIds, allowedRoleIds) {
  return isAdmin && hasAnyAllowedRole(memberRoleIds, allowedRoleIds);
}

function createAccessRoleStore(accessFile = ACCESS_FILE) {
  let rolesByGuild = {};
  let saveQueue = Promise.resolve();

  async function persist(updated) {
    const directory = path.dirname(accessFile);
    const temporaryFile = `${accessFile}.${process.pid}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporaryFile, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      await fs.rename(temporaryFile, accessFile);
    } catch (error) {
      await fs.rm(temporaryFile, { force: true }).catch((cleanupError) => {
        console.error("임시 접근 역할 설정 파일 정리 실패:", cleanupError);
      });
      throw error;
    }
    rolesByGuild = updated;
  }

  function enqueue(operation) {
    const result = saveQueue.then(operation);
    saveQueue = result.catch(() => {});
    return result;
  }

  async function load() {
    let contents;
    try {
      contents = await fs.readFile(accessFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        rolesByGuild = {};
        return;
      }
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`명령어 접근 역할 설정 파일을 읽을 수 없습니다 (${accessFile}): ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("명령어 접근 역할 설정 파일의 최상위 형식이 올바르지 않습니다.");
    }
    const validated = {};
    for (const [guildId, roleIds] of Object.entries(parsed)) {
      if (!SNOWFLAKE_PATTERN.test(guildId)) {
        throw new Error(`명령어 접근 역할 설정 파일에 잘못된 서버 ID가 있습니다: ${guildId}`);
      }
      validated[guildId] = normalizeRoleIds(roleIds);
    }
    rolesByGuild = validated;
  }

  function get(guildId) {
    return [...(rolesByGuild[guildId] ?? [])];
  }

  function save(guildId, roleIds) {
    if (typeof guildId !== "string" || !SNOWFLAKE_PATTERN.test(guildId)) {
      throw new TypeError("A valid guild ID is required.");
    }
    const normalized = normalizeRoleIds(roleIds);
    return enqueue(() => persist({ ...rolesByGuild, [guildId]: normalized }));
  }

  function clear(guildId) {
    if (typeof guildId !== "string" || !SNOWFLAKE_PATTERN.test(guildId)) {
      throw new TypeError("A valid guild ID is required.");
    }
    return enqueue(async () => {
      const updated = { ...rolesByGuild };
      delete updated[guildId];
      await persist(updated);
    });
  }

  return { clear, get, load, save };
}

const store = createAccessRoleStore();

module.exports = {
  createAccessRoleStore,
  canUseRestrictedCommand,
  getAllowedRoleIds: store.get,
  hasAnyAllowedRole,
  loadAccessRoles: store.load,
  setAllowedRoleIds: store.save,
  clearAllowedRoleIds: store.clear,
};
