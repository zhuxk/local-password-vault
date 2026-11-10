importScripts("vendor/psl.js", "shared/domain.js", "shared/crypto.js", "shared/csv.js", "shared/password.js");

"use strict";

const META_KEY = "vaultMeta";
const DATA_KEY = "vaultData";
const SESSION_KEY = "vaultSessionKey";
const SESSION_LOCK_MINUTES_KEY = "vaultAutoLockMinutes";
const PENDING_KEY_PREFIX = "pendingCredential:";
const STEP_KEY_PREFIX = "stepUsername:";
const AUTO_LOCK_ALARM = "vault-auto-lock";
const MAINTENANCE_ALARM = "vault-session-maintenance";
const ITERATIONS = 310000;
const PENDING_LIFETIME = 10 * 60 * 1000;
const STEP_LIFETIME = 10 * 60 * 1000;
const DEFAULT_AUTO_LOCK_MINUTES = 15;
const VALID_FILL_MODES = new Set(["auto", "click", "disabled"]);
let mutationQueue = Promise.resolve();

function frameContext(sender) {
  return {
    tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : -1,
    frameId: Number.isInteger(sender?.frameId) ? sender.frameId : 0
  };
}

function contextualStorageKey(prefix, tabId, frameId = 0) {
  return `${prefix}${tabId}:${frameId}`;
}

function queueMutation(callback) {
  const result = mutationQueue.then(callback, callback);
  mutationQueue = result.catch(() => undefined);
  return result;
}

async function notifyPages(type) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_error) {
    return;
  }
  await Promise.allSettled(tabs.map((tab) => {
    return Number.isInteger(tab.id) ? chrome.tabs.sendMessage(tab.id, { type }) : Promise.resolve();
  }));
}

async function readStoredVault() {
  const stored = await chrome.storage.local.get([META_KEY, DATA_KEY]);
  return { meta: stored[META_KEY], data: stored[DATA_KEY] };
}

function assertBase64(value, label) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label}格式损坏`);
  }
  try {
    return PasswordCrypto.base64ToBytes(value);
  } catch (_error) {
    throw new Error(`${label}格式损坏`);
  }
}

function validateEnvelope(meta, data) {
  if (!meta || typeof meta !== "object" || meta.kdf !== "PBKDF2-SHA256" ||
      !Number.isInteger(meta.iterations) || meta.iterations < 100000 || meta.iterations > 5000000) {
    throw new Error("密码库加密参数损坏或不受支持");
  }
  if (assertBase64(meta.salt, "密码库盐值").length < 16) {
    throw new Error("密码库盐值格式损坏");
  }
  if (!data || typeof data !== "object") {
    throw new Error("密码库密文缺失");
  }
  if (assertBase64(data.iv, "密码库 IV").length !== 12 ||
      assertBase64(data.ciphertext, "密码库密文").length < 17) {
    throw new Error("密码库密文格式损坏");
  }
}

function normalizeEntry(input) {
  if (!input || typeof input !== "object") {
    throw new Error("密码库中存在无效账号记录");
  }
  const parsed = PasswordDomain.parseWebsite(input.url);
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  if (!username || !password) {
    throw new Error("密码库中存在缺少用户名或密码的记录");
  }
  const now = new Date().toISOString();
  const passwordHistory = (Array.isArray(input.passwordHistory) ? input.passwordHistory : [])
    .filter((item) => item && typeof item.password === "string" && item.password && item.password !== password)
    .slice(0, 3)
    .map((item) => ({
      password: item.password,
      changedAt: typeof item.changedAt === "string" ? item.changedAt : now
    }));
  return {
    id: typeof input.id === "string" && input.id ? input.id : crypto.randomUUID(),
    name: String(input.name || "").trim().slice(0, 200),
    url: parsed.url,
    hostname: parsed.hostname,
    siteKey: parsed.siteKey,
    groupKey: parsed.groupKey,
    username,
    password,
    passwordHistory,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now
  };
}

function normalizeVault(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.entries)) {
    throw new Error("密码库数据结构损坏");
  }
  const entries = input.entries.map(normalizeEntry);
  const trash = (Array.isArray(input.trash) ? input.trash : []).map((item) => ({
    ...normalizeEntry(item),
    deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : new Date().toISOString()
  }));
  const siteSettings = {};
  if (input.siteSettings && typeof input.siteSettings === "object" && !Array.isArray(input.siteSettings)) {
    for (const [siteKey, setting] of Object.entries(input.siteSettings)) {
      const normalizedSetting = {};
      if (VALID_FILL_MODES.has(setting?.fillMode) && setting.fillMode !== "auto") {
        normalizedSetting.fillMode = setting.fillMode;
      }
      if (typeof setting?.defaultEntryId === "string" && setting.defaultEntryId) {
        normalizedSetting.defaultEntryId = setting.defaultEntryId;
      }
      if (Object.keys(normalizedSetting).length) {
        siteSettings[String(siteKey).trim().toLowerCase()] = normalizedSetting;
      }
    }
  }
  for (const [siteKey, setting] of Object.entries(siteSettings)) {
    if (setting.defaultEntryId && !entries.some((entry) => {
      return entry.siteKey === siteKey && entry.id === setting.defaultEntryId;
    })) {
      delete setting.defaultEntryId;
    }
    if (!Object.keys(setting).length) {
      delete siteSettings[siteKey];
    }
  }
  const configuredMinutes = Number(input.settings?.autoLockMinutes);
  const autoLockMinutes = [5, 15, 30, 60].includes(configuredMinutes)
    ? configuredMinutes
    : DEFAULT_AUTO_LOCK_MINUTES;
  const generator = PasswordGenerator.normalizeSettings(input.settings?.generator);
  const vault = {
    version: 3,
    entries,
    trash,
    siteSettings,
    settings: { autoLockMinutes, generator }
  };
  return { vault, changed: JSON.stringify(input) !== JSON.stringify(vault) };
}

async function getSessionKey() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  if (!stored[SESSION_KEY]) return null;
  try {
    return await PasswordCrypto.importKey(PasswordCrypto.base64ToBytes(stored[SESSION_KEY]));
  } catch (_error) {
    await chrome.storage.session.remove([SESSION_KEY, SESSION_LOCK_MINUTES_KEY]);
    return null;
  }
}

async function scheduleAutoLock(minutes) {
  const delay = [5, 15, 30, 60].includes(Number(minutes))
    ? Number(minutes)
    : DEFAULT_AUTO_LOCK_MINUTES;
  chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: delay });
}

async function setSessionKey(key, autoLockMinutes) {
  const raw = await PasswordCrypto.exportKey(key);
  await chrome.storage.session.set({
    [SESSION_KEY]: PasswordCrypto.bytesToBase64(raw),
    [SESSION_LOCK_MINUTES_KEY]: autoLockMinutes
  });
  await scheduleAutoLock(autoLockMinutes);
}

async function touchAutoLock() {
  const stored = await chrome.storage.session.get([SESSION_KEY, SESSION_LOCK_MINUTES_KEY]);
  if (stored[SESSION_KEY]) {
    await scheduleAutoLock(stored[SESSION_LOCK_MINUTES_KEY]);
  }
}

async function clearSensitiveSessionData() {
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter((key) => {
    return key === SESSION_KEY || key === SESSION_LOCK_MINUTES_KEY ||
      key.startsWith(PENDING_KEY_PREFIX) || key.startsWith(STEP_KEY_PREFIX);
  });
  if (keys.length) {
    await chrome.storage.session.remove(keys);
  }
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
}

async function lockVault() {
  await clearSensitiveSessionData();
  void notifyPages("VAULT_LOCKED");
  return { initialized: true, unlocked: false };
}

async function status() {
  const stored = await readStoredVault();
  const complete = Boolean(stored.meta && stored.data);
  const initialized = Boolean(stored.meta || stored.data);
  const key = complete ? await getSessionKey() : null;
  return {
    initialized,
    unlocked: Boolean(key),
    damaged: Boolean(stored.meta) !== Boolean(stored.data)
  };
}

async function decryptStoredVault(key, stored) {
  validateEnvelope(stored.meta, stored.data);
  const decrypted = await PasswordCrypto.decryptJson(stored.data, key);
  try {
    return normalizeVault(decrypted);
  } catch (error) {
    throw new Error(`密码库数据损坏：${error.message}`);
  }
}

async function requireVault() {
  const key = await getSessionKey();
  if (!key) {
    throw new Error("密码库尚未解锁");
  }
  const stored = await readStoredVault();
  if (!stored.meta || !stored.data) {
    await clearSensitiveSessionData();
    throw new Error("密码库数据缺失，请恢复备份或重建密码库");
  }
  try {
    return { key, ...await decryptStoredVault(key, stored) };
  } catch (error) {
    await clearSensitiveSessionData();
    if (/损坏|缺失|不受支持/.test(error.message || "")) {
      throw error;
    }
    throw new Error("密码库无法解密，数据可能已损坏，请重新解锁或恢复备份");
  }
}

async function writeVault(vault, key, notify = true) {
  await chrome.storage.local.set({ [DATA_KEY]: await PasswordCrypto.encryptJson(vault, key) });
  if (notify) {
    void notifyPages("VAULT_CHANGED");
  }
}

function cleanEntry(input, existing) {
  const parsed = PasswordDomain.parseWebsite(input.url);
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  if (!username) {
    throw new Error("请输入用户名");
  }
  if (!password) {
    throw new Error("请输入密码");
  }
  const now = new Date().toISOString();
  let passwordHistory = Array.isArray(existing?.passwordHistory)
    ? existing.passwordHistory.slice(0, 3)
    : [];
  if (existing && existing.password !== password) {
    passwordHistory = [
      { password: existing.password, changedAt: now },
      ...passwordHistory.filter((item) => item.password !== existing.password && item.password !== password)
    ].slice(0, 3);
  }
  return {
    id: existing?.id || crypto.randomUUID(),
    name: String(input.name || "").trim().slice(0, 200),
    url: parsed.url,
    hostname: parsed.hostname,
    siteKey: parsed.siteKey,
    groupKey: parsed.groupKey,
    username,
    password,
    passwordHistory,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function sortEntries(entries) {
  return entries.slice().sort((left, right) => {
    return left.groupKey.localeCompare(right.groupKey) ||
      left.siteKey.localeCompare(right.siteKey) ||
      left.username.localeCompare(right.username);
  });
}

async function createVault(password) {
  return queueMutation(async () => {
    if (typeof password !== "string" || password.length < 8) {
      throw new Error("主密码至少需要 8 个字符");
    }
    const current = await readStoredVault();
    if (current.meta || current.data) {
      throw new Error("密码库已经存在");
    }
    const salt = PasswordCrypto.randomBytes(16);
    const key = await PasswordCrypto.deriveKey(password, salt, ITERATIONS);
    const vault = {
      version: 3,
      entries: [],
      trash: [],
      siteSettings: {},
      settings: {
        autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
        generator: { ...PasswordGenerator.DEFAULT_SETTINGS }
      }
    };
    const meta = {
      version: 3,
      kdf: "PBKDF2-SHA256",
      iterations: ITERATIONS,
      salt: PasswordCrypto.bytesToBase64(salt),
      createdAt: new Date().toISOString()
    };
    const data = await PasswordCrypto.encryptJson(vault, key);
    await chrome.storage.local.set({ [META_KEY]: meta, [DATA_KEY]: data });
    await setSessionKey(key, vault.settings.autoLockMinutes);
    void notifyPages("VAULT_UNLOCKED");
    return { initialized: true, unlocked: true };
  });
}

async function unlock(password) {
  return queueMutation(async () => {
    const stored = await readStoredVault();
    if (!stored.meta && !stored.data) {
      throw new Error("请先创建密码库或恢复加密备份");
    }
    if (!stored.meta || !stored.data) {
      throw new Error("密码库数据不完整，请恢复备份或删除后重建");
    }
    validateEnvelope(stored.meta, stored.data);
    const key = await PasswordCrypto.deriveKey(
      password,
      PasswordCrypto.base64ToBytes(stored.meta.salt),
      stored.meta.iterations
    );
    let normalized;
    try {
      normalized = await decryptStoredVault(key, stored);
    } catch (error) {
      if (/损坏|缺失|不受支持/.test(error.message || "")) {
        throw error;
      }
      throw new Error("主密码错误，或密码库密文已损坏");
    }
    if (normalized.changed) {
      await writeVault(normalized.vault, key, false);
    }
    if (stored.meta.version !== 3) {
      await chrome.storage.local.set({ [META_KEY]: { ...stored.meta, version: 3 } });
    }
    await setSessionKey(key, normalized.vault.settings.autoLockMinutes);
    void notifyPages("VAULT_UNLOCKED");
    return { initialized: true, unlocked: true };
  });
}

async function listVault() {
  return queueMutation(async () => {
    const { key, vault, changed } = await requireVault();
    if (changed) {
      await writeVault(vault, key);
    }
    return {
      entries: sortEntries(vault.entries),
      trash: vault.trash.slice().sort((left, right) => right.deletedAt.localeCompare(left.deletedAt)),
      siteSettings: vault.siteSettings,
      settings: vault.settings
    };
  });
}

async function currentEntries(url) {
  const parsed = PasswordDomain.parseWebsite(url);
  const result = await listVault();
  const setting = result.siteSettings[parsed.siteKey] || {};
  const entries = result.entries
    .filter((entry) => entry.siteKey === parsed.siteKey)
    .map((entry) => {
      const { passwordHistory: _passwordHistory, ...currentEntry } = entry;
      return currentEntry;
    });
  if (setting.defaultEntryId) {
    entries.sort((left, right) => {
      return Number(right.id === setting.defaultEntryId) - Number(left.id === setting.defaultEntryId);
    });
  }
  return {
    siteKey: parsed.siteKey,
    hostname: parsed.hostname,
    fillMode: setting.fillMode || "auto",
    defaultEntryId: setting.defaultEntryId || "",
    generatorSettings: result.settings.generator,
    entries
  };
}

async function saveEntry(input) {
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    const index = input.id ? vault.entries.findIndex((entry) => entry.id === input.id) : -1;
    if (input.id && index < 0) {
      throw new Error("没有找到要修改的账号");
    }
    let existing = index >= 0 ? vault.entries[index] : null;
    let targetIndex = index;
    const candidate = cleanEntry(input, existing);
    const duplicateIndex = vault.entries.findIndex((entry, entryIndex) => {
      return entryIndex !== index && entry.siteKey === candidate.siteKey && entry.username === candidate.username;
    });
    if (duplicateIndex >= 0) {
      if (index >= 0 || input.onDuplicate !== "update") {
        throw new Error("该站点已存在相同用户名的账号");
      }
      targetIndex = duplicateIndex;
      existing = vault.entries[duplicateIndex];
    }
    const entry = cleanEntry(input, existing);
    if (targetIndex >= 0) {
      vault.entries[targetIndex] = entry;
    } else {
      vault.entries.push(entry);
    }
    await writeVault(vault, key);
    return entry;
  });
}

async function deleteEntry(id) {
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    const index = vault.entries.findIndex((entry) => entry.id === id);
    if (index < 0) {
      throw new Error("没有找到要删除的账号");
    }
    const [entry] = vault.entries.splice(index, 1);
    vault.trash.unshift({ ...entry, deletedAt: new Date().toISOString() });
    if (vault.siteSettings[entry.siteKey]?.defaultEntryId === entry.id) {
      delete vault.siteSettings[entry.siteKey].defaultEntryId;
      if (!Object.keys(vault.siteSettings[entry.siteKey]).length) {
        delete vault.siteSettings[entry.siteKey];
      }
    }
    await writeVault(vault, key);
    return true;
  });
}

async function deleteGroup(groupKey) {
  return queueMutation(async () => {
    const normalized = String(groupKey || "").trim().toLowerCase();
    const { key, vault } = await requireVault();
    const deletedEntries = vault.entries.filter((entry) => entry.groupKey === normalized);
    if (!deletedEntries.length) {
      throw new Error("该分组下没有可删除的账号");
    }
    vault.entries = vault.entries.filter((entry) => entry.groupKey !== normalized);
    for (const entry of deletedEntries) {
      if (vault.siteSettings[entry.siteKey]?.defaultEntryId === entry.id) {
        delete vault.siteSettings[entry.siteKey].defaultEntryId;
        if (!Object.keys(vault.siteSettings[entry.siteKey]).length) {
          delete vault.siteSettings[entry.siteKey];
        }
      }
    }
    const deletedAt = new Date().toISOString();
    vault.trash.unshift(...deletedEntries.map((entry) => ({ ...entry, deletedAt })));
    await writeVault(vault, key);
    return deletedEntries.length;
  });
}

async function restoreTrash(id) {
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    const index = vault.trash.findIndex((entry) => entry.id === id);
    if (index < 0) {
      throw new Error("回收站中没有找到该账号");
    }
    const [entry] = vault.trash.splice(index, 1);
    delete entry.deletedAt;
    const conflict = vault.entries.findIndex((item) => {
      return item.siteKey === entry.siteKey && item.username === entry.username;
    });
    if (conflict >= 0) {
      entry.id = vault.entries[conflict].id;
      entry.createdAt = vault.entries[conflict].createdAt;
      entry.updatedAt = new Date().toISOString();
      vault.entries[conflict] = entry;
    } else {
      vault.entries.push(entry);
    }
    await writeVault(vault, key);
    return entry;
  });
}

async function permanentlyDeleteTrash(id) {
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    const nextTrash = vault.trash.filter((entry) => entry.id !== id);
    if (nextTrash.length === vault.trash.length) {
      throw new Error("回收站中没有找到该账号");
    }
    vault.trash = nextTrash;
    await writeVault(vault, key);
    return true;
  });
}

async function emptyTrash() {
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    const count = vault.trash.length;
    vault.trash = [];
    if (count) {
      await writeVault(vault, key);
    }
    return count;
  });
}

async function setSiteMode(url, siteKey, fillMode) {
  if (!VALID_FILL_MODES.has(fillMode)) {
    throw new Error("不支持的填充方式");
  }
  const normalizedSiteKey = url
    ? PasswordDomain.parseWebsite(url).siteKey
    : String(siteKey || "").trim().toLowerCase();
  if (!normalizedSiteKey) {
    throw new Error("站点地址不能为空");
  }
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    const setting = { ...(vault.siteSettings[normalizedSiteKey] || {}) };
    if (fillMode === "auto") {
      delete setting.fillMode;
    } else {
      setting.fillMode = fillMode;
    }
    if (Object.keys(setting).length) {
      vault.siteSettings[normalizedSiteKey] = setting;
    } else {
      delete vault.siteSettings[normalizedSiteKey];
    }
    await writeVault(vault, key);
    return { siteKey: normalizedSiteKey, fillMode };
  });
}

async function setDefaultEntry(siteKey, entryId) {
  const normalizedSiteKey = String(siteKey || "").trim().toLowerCase();
  if (!normalizedSiteKey) {
    throw new Error("站点地址不能为空");
  }
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    const normalizedEntryId = String(entryId || "");
    if (normalizedEntryId && !vault.entries.some((entry) => {
      return entry.siteKey === normalizedSiteKey && entry.id === normalizedEntryId;
    })) {
      throw new Error("默认账号不属于当前站点");
    }
    const setting = { ...(vault.siteSettings[normalizedSiteKey] || {}) };
    if (normalizedEntryId) {
      setting.defaultEntryId = normalizedEntryId;
    } else {
      delete setting.defaultEntryId;
    }
    if (Object.keys(setting).length) {
      vault.siteSettings[normalizedSiteKey] = setting;
    } else {
      delete vault.siteSettings[normalizedSiteKey];
    }
    await writeVault(vault, key);
    return { siteKey: normalizedSiteKey, defaultEntryId: normalizedEntryId };
  });
}

async function setAutoLockMinutes(minutes) {
  const value = Number(minutes);
  if (![5, 15, 30, 60].includes(value)) {
    throw new Error("不支持的自动锁定时长");
  }
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    vault.settings.autoLockMinutes = value;
    await writeVault(vault, key);
    await setSessionKey(key, value);
    return value;
  });
}

async function setGeneratorSettings(settings) {
  return queueMutation(async () => {
    const { key, vault } = await requireVault();
    vault.settings.generator = PasswordGenerator.normalizeSettings(settings);
    await writeVault(vault, key);
    return vault.settings.generator;
  });
}

async function importCsv(text) {
  return queueMutation(async () => {
    const rows = PasswordCsv.parsePasswordCsv(text);
    const { key, vault } = await requireVault();
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const candidate = cleanEntry(row, null);
        const index = vault.entries.findIndex((entry) => {
          return entry.siteKey === candidate.siteKey && entry.username === candidate.username;
        });
        if (index < 0) {
          vault.entries.push(candidate);
          added += 1;
        } else if (vault.entries[index].password === candidate.password &&
                   vault.entries[index].url === candidate.url) {
          skipped += 1;
        } else {
          vault.entries[index] = cleanEntry(row, vault.entries[index]);
          updated += 1;
        }
      } catch (_error) {
        skipped += 1;
      }
    }
    if (added || updated) {
      await writeVault(vault, key);
    }
    return { added, updated, skipped, total: rows.length };
  });
}

async function exportBackup() {
  await mutationQueue;
  await requireVault();
  const stored = await readStoredVault();
  return JSON.stringify({
    format: "local-password-vault-backup",
    version: 3,
    exportedAt: new Date().toISOString(),
    meta: stored.meta,
    data: stored.data
  }, null, 2);
}

function parseBackup(text) {
  let backup;
  try {
    backup = JSON.parse(String(text || ""));
  } catch (_error) {
    throw new Error("备份文件不是有效的 JSON");
  }
  if (backup?.format !== "local-password-vault-backup" || ![1, 2, 3].includes(backup.version)) {
    throw new Error("不是本扩展支持的加密备份文件");
  }
  validateEnvelope(backup.meta, backup.data);
  return backup;
}

async function importBackup(text, password, confirmReplace) {
  return queueMutation(async () => {
    const backup = parseBackup(text);
    const current = await readStoredVault();
    if ((current.meta || current.data) && confirmReplace !== true) {
      throw new Error("恢复备份会替换当前密码库，请先确认替换");
    }
    const key = await PasswordCrypto.deriveKey(
      String(password || ""),
      PasswordCrypto.base64ToBytes(backup.meta.salt),
      backup.meta.iterations
    );
    let decrypted;
    try {
      decrypted = await PasswordCrypto.decryptJson(backup.data, key);
    } catch (_error) {
      throw new Error("备份主密码错误，或备份密文已损坏");
    }
    let normalized;
    try {
      normalized = normalizeVault(decrypted);
    } catch (error) {
      throw new Error(`备份内容校验失败：${error.message}`);
    }
    const meta = { ...backup.meta, version: 3, restoredAt: new Date().toISOString() };
    const data = await PasswordCrypto.encryptJson(normalized.vault, key);
    await chrome.storage.local.set({ [META_KEY]: meta, [DATA_KEY]: data });
    await clearSensitiveSessionData();
    await setSessionKey(key, normalized.vault.settings.autoLockMinutes);
    void notifyPages("VAULT_UNLOCKED");
    return { entries: normalized.vault.entries.length, trash: normalized.vault.trash.length };
  });
}

async function changeMasterPassword(currentPassword, newPassword) {
  return queueMutation(async () => {
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      throw new Error("新主密码至少需要 8 个字符");
    }
    const stored = await readStoredVault();
    validateEnvelope(stored.meta, stored.data);
    const oldKey = await PasswordCrypto.deriveKey(
      String(currentPassword || ""),
      PasswordCrypto.base64ToBytes(stored.meta.salt),
      stored.meta.iterations
    );
    let normalized;
    try {
      normalized = await decryptStoredVault(oldKey, stored);
    } catch (_error) {
      throw new Error("当前主密码不正确");
    }
    const salt = PasswordCrypto.randomBytes(16);
    const key = await PasswordCrypto.deriveKey(newPassword, salt, ITERATIONS);
    const meta = {
      ...stored.meta,
      version: 3,
      iterations: ITERATIONS,
      salt: PasswordCrypto.bytesToBase64(salt),
      passwordChangedAt: new Date().toISOString()
    };
    const data = await PasswordCrypto.encryptJson(normalized.vault, key);
    await chrome.storage.local.set({ [META_KEY]: meta, [DATA_KEY]: data });
    await setSessionKey(key, normalized.vault.settings.autoLockMinutes);
    void notifyPages("VAULT_CHANGED");
    return true;
  });
}

async function deleteVault(confirmation) {
  if (confirmation !== "删除密码库") {
    throw new Error("请输入“删除密码库”确认操作");
  }
  return queueMutation(async () => {
    await chrome.storage.local.remove([META_KEY, DATA_KEY]);
    await clearSensitiveSessionData();
    void notifyPages("VAULT_LOCKED");
    return true;
  });
}

async function readTimedSession(prefix, context, lifetime) {
  const key = contextualStorageKey(prefix, context.tabId, context.frameId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  if (value && Date.now() - value.capturedAt > lifetime) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return value || null;
}

async function readPending(url, context) {
  const pending = await readTimedSession(PENDING_KEY_PREFIX, context, PENDING_LIFETIME);
  return pending || null;
}

async function inspectPending(pending, context) {
  if (!await getSessionKey()) {
    return { action: "locked", pending };
  }
  const { vault } = await requireVault();
  const existing = vault.entries.find((entry) => {
    return entry.siteKey === pending.siteKey && entry.username === pending.username;
  });
  if (existing?.password === pending.password) {
    await chrome.storage.session.remove(contextualStorageKey(PENDING_KEY_PREFIX, context.tabId, context.frameId));
    return { action: "none", pending: null };
  }
  return {
    action: existing ? "update" : "save",
    pending: { ...pending, existingId: existing?.id || null }
  };
}

async function saveStepUsername(input, context) {
  const username = String(input.username || "").trim();
  if (!username) {
    return { saved: false };
  }
  const parsed = PasswordDomain.parseWebsite(input.url);
  await chrome.storage.session.set({
    [contextualStorageKey(STEP_KEY_PREFIX, context.tabId, context.frameId)]: {
      username,
      siteKey: parsed.siteKey,
      capturedAt: Date.now()
    }
  });
  return { saved: true };
}

async function getStepUsername(url, context) {
  const step = await readTimedSession(STEP_KEY_PREFIX, context, STEP_LIFETIME);
  if (!step || PasswordDomain.parseWebsite(url).siteKey !== step.siteKey) {
    return { username: "" };
  }
  return { username: step.username };
}

async function captureCredential(input, context) {
  let username = String(input.username || "").trim();
  if (!username) {
    username = (await getStepUsername(input.url, context)).username;
  }
  const entry = cleanEntry({ ...input, username }, null);
  const pending = {
    id: crypto.randomUUID(),
    url: entry.url,
    hostname: entry.hostname,
    siteKey: entry.siteKey,
    name: entry.name,
    username: entry.username,
    password: entry.password,
    capturedAt: Date.now()
  };
  await chrome.storage.session.set({
    [contextualStorageKey(PENDING_KEY_PREFIX, context.tabId, context.frameId)]: pending
  });
  return inspectPending(pending, context);
}

async function savePending(id, context) {
  return queueMutation(async () => {
    const pending = await readPending(null, context);
    if (!pending || pending.id !== id) {
      throw new Error("待保存的登录信息已失效");
    }
    if (!await getSessionKey()) {
      throw new Error("请先点击扩展图标解锁密码库");
    }
    const { key, vault } = await requireVault();
    const index = vault.entries.findIndex((entry) => {
      return entry.siteKey === pending.siteKey && entry.username === pending.username;
    });
    const storageKey = contextualStorageKey(PENDING_KEY_PREFIX, context.tabId, context.frameId);
    if (index >= 0 && vault.entries[index].password === pending.password) {
      await chrome.storage.session.remove(storageKey);
      return { saved: false };
    }
    const existing = index >= 0 ? vault.entries[index] : null;
    const entry = cleanEntry({
      name: pending.name,
      url: pending.url,
      username: pending.username,
      password: pending.password
    }, existing);
    if (index >= 0) {
      vault.entries[index] = entry;
    } else {
      vault.entries.push(entry);
    }
    await writeVault(vault, key);
    await chrome.storage.session.remove(storageKey);
    return { saved: true, entry };
  });
}

async function dismissPending(id, context) {
  const pending = await readPending(null, context);
  if (!pending || !id || pending.id === id) {
    await chrome.storage.session.remove(contextualStorageKey(PENDING_KEY_PREFIX, context.tabId, context.frameId));
  }
  return { dismissed: true };
}

async function cleanupExpiredSessionData() {
  const stored = await chrome.storage.session.get(null);
  const now = Date.now();
  const keys = [];
  for (const [key, value] of Object.entries(stored)) {
    const lifetime = key.startsWith(PENDING_KEY_PREFIX)
      ? PENDING_LIFETIME
      : key.startsWith(STEP_KEY_PREFIX) ? STEP_LIFETIME : 0;
    if (lifetime && (!value?.capturedAt || now - value.capturedAt > lifetime)) {
      keys.push(key);
    }
  }
  if (keys.length) {
    await chrome.storage.session.remove(keys);
  }
}

async function clearTabSessionData(tabId) {
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter((key) => {
    return key.startsWith(`${PENDING_KEY_PREFIX}${tabId}:`) ||
      key.startsWith(`${STEP_KEY_PREFIX}${tabId}:`);
  });
  if (keys.length) {
    await chrome.storage.session.remove(keys);
  }
}

async function handleMessage(message, sender) {
  const context = frameContext(sender);
  let result;
  switch (message?.type) {
    case "STATUS": result = await status(); break;
    case "TOUCH": result = { touched: true }; break;
    case "CREATE_VAULT": result = await createVault(message.password); break;
    case "UNLOCK": result = await unlock(message.password); break;
    case "LOCK": return lockVault();
    case "LIST_ENTRIES": result = await listVault(); break;
    case "CURRENT_ENTRIES": result = await currentEntries(message.url); break;
    case "SAVE_ENTRY": result = { entry: await saveEntry(message.entry || {}) }; break;
    case "DELETE_ENTRY": result = { deleted: await deleteEntry(message.id) }; break;
    case "DELETE_GROUP": result = { deleted: await deleteGroup(message.groupKey) }; break;
    case "RESTORE_TRASH": result = { entry: await restoreTrash(message.id) }; break;
    case "DELETE_TRASH": result = { deleted: await permanentlyDeleteTrash(message.id) }; break;
    case "EMPTY_TRASH": result = { deleted: await emptyTrash() }; break;
    case "SET_SITE_MODE": result = await setSiteMode(message.url, message.siteKey, message.fillMode); break;
    case "SET_DEFAULT_ENTRY": result = await setDefaultEntry(message.siteKey, message.entryId); break;
    case "SET_AUTO_LOCK": result = { minutes: await setAutoLockMinutes(message.minutes) }; break;
    case "SET_GENERATOR_SETTINGS": result = { settings: await setGeneratorSettings(message.settings) }; break;
    case "IMPORT_CSV": result = await importCsv(message.text); break;
    case "EXPORT_BACKUP": result = { text: await exportBackup() }; break;
    case "IMPORT_BACKUP":
      result = await importBackup(message.text, message.password, message.confirmReplace);
      break;
    case "CHANGE_MASTER_PASSWORD":
      result = { changed: await changeMasterPassword(message.currentPassword, message.newPassword) };
      break;
    case "DELETE_VAULT": return { deleted: await deleteVault(message.confirmation) };
    case "CAPTURE_STEP_USERNAME": result = await saveStepUsername(message.credential || {}, context); break;
    case "GET_STEP_USERNAME": result = await getStepUsername(message.url, context); break;
    case "CAPTURE_CREDENTIAL": result = await captureCredential(message.credential || {}, context); break;
    case "GET_PENDING_CREDENTIAL": {
      const pending = await readPending(message.url, context);
      result = pending ? await inspectPending(pending, context) : { action: "none", pending: null };
      break;
    }
    case "SAVE_PENDING_CREDENTIAL": result = await savePending(message.id, context); break;
    case "DISMISS_PENDING_CREDENTIAL": result = await dismissPending(message.id, context); break;
    case "OPEN_MANAGER":
      await chrome.runtime.openOptionsPage();
      result = { opened: true };
      break;
    default: throw new Error("不支持的操作");
  }
  await touchAutoLock();
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "操作失败" }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    void lockVault();
  } else if (alarm.name === MAINTENANCE_ALARM) {
    void cleanupExpiredSessionData();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabSessionData(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
