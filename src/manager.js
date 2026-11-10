"use strict";

const ui = {
  message: document.querySelector("#message"),
  setupView: document.querySelector("#setup-view"),
  unlockView: document.querySelector("#unlock-view"),
  vaultView: document.querySelector("#vault-view"),
  lockButton: document.querySelector("#lock-button"),
  searchInput: document.querySelector("#search-input"),
  sortSelect: document.querySelector("#sort-select"),
  groups: document.querySelector("#groups"),
  emptyState: document.querySelector("#empty-state"),
  trashList: document.querySelector("#trash-list"),
  trashEmpty: document.querySelector("#trash-empty"),
  emptyTrashButton: document.querySelector("#empty-trash-button"),
  autoLockSelect: document.querySelector("#auto-lock-select"),
  dialog: document.querySelector("#entry-dialog"),
  dialogHeading: document.querySelector("#dialog-heading"),
  entryId: document.querySelector("#entry-id"),
  entryName: document.querySelector("#entry-name"),
  entryUrl: document.querySelector("#entry-url"),
  entryUsername: document.querySelector("#entry-username"),
  entryPassword: document.querySelector("#entry-password"),
  togglePasswordButton: document.querySelector("#toggle-password-button"),
  passwordHistorySection: document.querySelector("#password-history-section"),
  passwordHistoryList: document.querySelector("#password-history-list"),
  deleteButton: document.querySelector("#delete-button"),
  restoreDialog: document.querySelector("#restore-dialog"),
  restorePassword: document.querySelector("#restore-password"),
  replaceConfirmRow: document.querySelector("#replace-confirm-row"),
  replaceConfirm: document.querySelector("#replace-confirm"),
  changePasswordForm: document.querySelector("#change-password-form"),
  generatorSettingsForm: document.querySelector("#generator-settings-form"),
  generatorLength: document.querySelector("#generator-length"),
  generatorUppercase: document.querySelector("#generator-uppercase"),
  generatorLowercase: document.querySelector("#generator-lowercase"),
  generatorNumbers: document.querySelector("#generator-numbers"),
  generatorSymbols: document.querySelector("#generator-symbols")
};

let entries = [];
let trash = [];
let siteSettings = {};
let generatorSettings = { ...PasswordGenerator.DEFAULT_SETTINGS };
let backupText = "";
let currentStatus = { initialized: false, unlocked: false };

function show(element, visible = true) {
  element.classList.toggle("hidden", !visible);
}

function showMessage(text, isError = false) {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
  show(ui.message, Boolean(text));
}

function restoreScrollPosition(position) {
  requestAnimationFrame(() => window.scrollTo({ top: position, behavior: "auto" }));
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "操作失败");
  return response.data;
}

async function renderState() {
  currentStatus = await request({ type: "STATUS" });
  show(ui.setupView, !currentStatus.initialized);
  show(ui.unlockView, currentStatus.initialized && !currentStatus.unlocked);
  show(ui.vaultView, currentStatus.unlocked);
  show(ui.lockButton, currentStatus.unlocked);
  if (currentStatus.damaged) {
    showMessage("密码库数据不完整，请恢复加密备份，或删除后重新创建。", true);
  }
  if (currentStatus.unlocked) await loadVault();
}

async function loadVault() {
  const result = await request({ type: "LIST_ENTRIES" });
  entries = result.entries;
  trash = result.trash;
  siteSettings = result.siteSettings;
  generatorSettings = PasswordGenerator.normalizeSettings(result.settings.generator);
  ui.autoLockSelect.value = String(result.settings.autoLockMinutes);
  ui.generatorLength.value = String(generatorSettings.length);
  ui.generatorUppercase.checked = generatorSettings.uppercase;
  ui.generatorLowercase.checked = generatorSettings.lowercase;
  ui.generatorNumbers.checked = generatorSettings.numbers;
  ui.generatorSymbols.checked = generatorSettings.symbols;
  renderEntries();
  renderTrash();
}

function createFillModeSelect(siteKey) {
  const select = document.createElement("select");
  select.className = "site-mode-select";
  select.setAttribute("aria-label", `${siteKey} 的填充方式`);
  for (const [value, label] of [["auto", "自动填充"], ["click", "点击填充"], ["disabled", "禁用"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = siteSettings[siteKey]?.fillMode || "auto";
  select.addEventListener("change", async () => {
    const scrollPosition = window.scrollY;
    try {
      await request({ type: "SET_SITE_MODE", siteKey, fillMode: select.value });
      const setting = { ...(siteSettings[siteKey] || {}) };
      if (select.value === "auto") delete setting.fillMode;
      else setting.fillMode = select.value;
      if (Object.keys(setting).length) siteSettings[siteKey] = setting;
      else delete siteSettings[siteKey];
      showMessage(`已更新 ${siteKey} 的填充方式`);
    } catch (error) {
      showMessage(error.message, true);
      select.value = siteSettings[siteKey]?.fillMode || "auto";
    }
    restoreScrollPosition(scrollPosition);
  });
  return select;
}

function createDefaultEntrySelect(siteKey, siteEntries) {
  const select = document.createElement("select");
  select.className = "default-entry-select";
  select.setAttribute("aria-label", `${siteKey} 的默认账号`);
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "默认账号：自动选择第一个";
  select.append(automatic);
  for (const entry of siteEntries) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `默认账号：${entry.username}`;
    select.append(option);
  }
  select.value = siteSettings[siteKey]?.defaultEntryId || "";
  select.addEventListener("change", async () => {
    const previousValue = siteSettings[siteKey]?.defaultEntryId || "";
    try {
      await request({ type: "SET_DEFAULT_ENTRY", siteKey, entryId: select.value });
      const setting = { ...(siteSettings[siteKey] || {}) };
      if (select.value) setting.defaultEntryId = select.value;
      else delete setting.defaultEntryId;
      if (Object.keys(setting).length) siteSettings[siteKey] = setting;
      else delete siteSettings[siteKey];
      renderEntries();
      showMessage(select.value ? "默认账号已更新" : "已恢复自动选择第一个账号");
    } catch (error) {
      select.value = previousValue;
      showMessage(error.message, true);
    }
  });
  return select;
}

function compareEntries(left, right) {
  const siteOrder = left.groupKey.localeCompare(right.groupKey) || left.siteKey.localeCompare(right.siteKey);
  if (siteOrder) return siteOrder;
  if (ui.sortSelect.value === "updated") {
    return right.updatedAt.localeCompare(left.updatedAt) || left.username.localeCompare(right.username);
  }
  return left.username.localeCompare(right.username);
}

function renderEntries() {
  const query = ui.searchInput.value.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    return !query || entry.hostname.toLowerCase().includes(query) ||
      entry.siteKey.toLowerCase().includes(query) || entry.url.toLowerCase().includes(query) ||
      entry.username.toLowerCase().includes(query) || (entry.name || "").toLowerCase().includes(query);
  }).sort(compareEntries);
  ui.groups.replaceChildren();
  show(ui.emptyState, filtered.length === 0);
  const grouped = new Map();
  for (const entry of filtered) {
    if (!grouped.has(entry.groupKey)) grouped.set(entry.groupKey, []);
    grouped.get(entry.groupKey).push(entry);
  }
  for (const [groupName, groupEntries] of grouped) {
    const section = document.createElement("section");
    section.className = "group card";
    const heading = document.createElement("div");
    heading.className = "group-heading";
    const title = document.createElement("h2");
    title.textContent = groupName;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(groupEntries.length);
    const spacer = document.createElement("span");
    spacer.className = "group-spacer";
    const deleteGroupButton = document.createElement("button");
    deleteGroupButton.type = "button";
    deleteGroupButton.className = "group-delete";
    deleteGroupButton.textContent = "移到回收站";
    deleteGroupButton.addEventListener("click", () => deleteDomainGroup(groupName));
    heading.append(title, count, spacer, deleteGroupButton);
    section.append(heading);
    const sites = new Map();
    for (const entry of groupEntries) {
      if (!sites.has(entry.siteKey)) sites.set(entry.siteKey, []);
      sites.get(entry.siteKey).push(entry);
    }
    const siteList = document.createElement("div");
    siteList.className = "site-list";
    for (const [siteKey, siteEntries] of sites) {
      const siteBlock = document.createElement("section");
      siteBlock.className = "site-block";
      const siteHeading = document.createElement("div");
      siteHeading.className = "site-heading";
      const siteTitle = document.createElement("h3");
      siteTitle.textContent = siteKey === groupName && !siteKey.includes(":")
        ? `${siteKey}（根域名 / www）`
        : siteKey;
      const siteCount = document.createElement("span");
      siteCount.className = "site-count";
      siteCount.textContent = `${siteEntries.length} 个账号`;
      siteHeading.append(
        siteTitle,
        createDefaultEntrySelect(siteKey, entries.filter((entry) => entry.siteKey === siteKey)),
        createFillModeSelect(siteKey),
        siteCount
      );
      siteBlock.append(siteHeading);
      for (const entry of siteEntries) siteBlock.append(createEntryRow(entry));
      siteList.append(siteBlock);
    }
    section.append(siteList);
    ui.groups.append(section);
  }
}

function createEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "entry";
  const account = document.createElement("div");
  account.className = "entry-account";
  const username = document.createElement("strong");
  username.textContent = entry.username;
  account.append(username);
  if (siteSettings[entry.siteKey]?.defaultEntryId === entry.id) {
    const defaultBadge = document.createElement("small");
    defaultBadge.className = "default-badge";
    defaultBadge.textContent = "默认账号";
    account.append(defaultBadge);
  }
  if (entry.name && !isRepeatedSiteName(entry.name.trim().toLowerCase(), entry)) {
    const name = document.createElement("small");
    name.textContent = entry.name;
    account.append(name);
  }
  const address = document.createElement("span");
  address.textContent = entry.url;
  address.title = entry.url;
  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const copyAccount = document.createElement("button");
  copyAccount.type = "button";
  copyAccount.textContent = "复制账号";
  copyAccount.addEventListener("click", () => copyToClipboard(entry.username, "账号"));
  const copyPassword = document.createElement("button");
  copyPassword.type = "button";
  copyPassword.textContent = "复制密码";
  copyPassword.addEventListener("click", () => copyToClipboard(entry.password, "密码"));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "编辑";
  edit.addEventListener("click", () => openDialog(entry));
  actions.append(copyAccount, copyPassword, edit);
  row.append(account, address, actions);
  return row;
}

function copyWithExecCommand(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function copyToClipboard(value, label) {
  try {
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      if (!copyWithExecCommand(value)) throw error;
    }
    showMessage(`${label}已复制`);
  } catch (error) {
    showMessage(error.message || `复制${label}失败`, true);
  }
}

function isRepeatedSiteName(normalizedName, entry) {
  if (!normalizedName) return false;
  const siteKey = String(entry.siteKey || "").toLowerCase();
  const hostname = String(entry.hostname || "").toLowerCase();
  if (normalizedName === siteKey || normalizedName === hostname) return true;
  if (!/^https?:\/\//.test(normalizedName)) return false;
  try {
    const titleUrl = new URL(normalizedName);
    return [siteKey, hostname].includes(titleUrl.host.toLowerCase()) ||
      [siteKey, hostname].includes(titleUrl.hostname.toLowerCase());
  } catch (_error) {
    return true;
  }
}

function renderTrash() {
  ui.trashList.replaceChildren();
  show(ui.trashEmpty, trash.length === 0);
  show(ui.emptyTrashButton, trash.length > 0);
  for (const entry of trash) {
    const row = document.createElement("div");
    row.className = "trash-entry";
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${entry.siteKey} · ${entry.username}`;
    const time = document.createElement("small");
    time.textContent = `删除于 ${new Date(entry.deletedAt).toLocaleString()}`;
    detail.append(title, time);
    const actions = document.createElement("div");
    const restore = document.createElement("button");
    restore.className = "quiet";
    restore.type = "button";
    restore.textContent = "恢复";
    restore.addEventListener("click", () => handleTrashAction("RESTORE_TRASH", entry.id, "账号已恢复"));
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.type = "button";
    remove.textContent = "永久删除";
    remove.addEventListener("click", () => {
      if (confirm("永久删除后无法恢复，确定继续吗？")) {
        void handleTrashAction("DELETE_TRASH", entry.id, "账号已永久删除");
      }
    });
    actions.append(restore, remove);
    row.append(detail, actions);
    ui.trashList.append(row);
  }
}

async function handleTrashAction(type, id, message) {
  const scrollPosition = window.scrollY;
  try {
    await request({ type, id });
    await loadVault();
    showMessage(message);
  } catch (error) {
    showMessage(error.message, true);
  }
  restoreScrollPosition(scrollPosition);
}

function openDialog(entry = null) {
  ui.dialogHeading.textContent = entry ? "编辑账号" : "添加账号";
  ui.entryId.value = entry?.id || "";
  ui.entryName.value = entry?.name || "";
  ui.entryUrl.value = entry?.url || "";
  ui.entryUsername.value = entry?.username || "";
  ui.entryPassword.value = entry?.password || "";
  renderPasswordHistory(entry?.passwordHistory || []);
  setPasswordVisibility(false);
  show(ui.deleteButton, Boolean(entry));
  ui.dialog.showModal();
  ui.entryUrl.focus();
}

function renderPasswordHistory(history) {
  ui.passwordHistoryList.replaceChildren();
  show(ui.passwordHistorySection, history.length > 0);
  for (const item of history) {
    const row = document.createElement("div");
    row.className = "password-history-entry";
    const detail = document.createElement("span");
    detail.textContent = `更换于 ${new Date(item.changedAt).toLocaleString()}`;
    const actions = document.createElement("div");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "quiet";
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyToClipboard(item.password, "旧密码"));
    const use = document.createElement("button");
    use.type = "button";
    use.className = "quiet";
    use.textContent = "使用此密码";
    use.addEventListener("click", () => {
      ui.entryPassword.value = item.password;
      setPasswordVisibility(true);
      ui.entryPassword.focus();
    });
    actions.append(copy, use);
    row.append(detail, actions);
    ui.passwordHistoryList.append(row);
  }
}

function setPasswordVisibility(visible) {
  ui.entryPassword.type = visible ? "text" : "password";
  ui.togglePasswordButton.classList.toggle("visible", visible);
  ui.togglePasswordButton.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  ui.togglePasswordButton.title = visible ? "隐藏密码" : "显示密码";
}

async function deleteDomainGroup(groupKey) {
  const total = entries.filter((entry) => entry.groupKey === groupKey).length;
  if (!confirm(`确定把 ${groupKey} 分组下的 ${total} 个账号移到回收站吗？`)) return;
  const scrollPosition = window.scrollY;
  try {
    const result = await request({ type: "DELETE_GROUP", groupKey });
    await loadVault();
    showMessage(`已把 ${result.deleted} 个账号移到回收站`);
  } catch (error) {
    showMessage(error.message, true);
  }
  restoreScrollPosition(scrollPosition);
}

function generatePassword() {
  return PasswordGenerator.generate(generatorSettings);
}

async function openRestoreDialog(file) {
  backupText = await file.text();
  ui.restorePassword.value = "";
  ui.replaceConfirm.checked = false;
  show(ui.replaceConfirmRow, currentStatus.initialized);
  ui.restoreDialog.showModal();
  ui.restorePassword.focus();
}

async function deleteWholeVault() {
  const confirmation = prompt("此操作会永久删除当前密码库。请输入“删除密码库”确认：");
  if (confirmation === null) return;
  try {
    await request({ type: "DELETE_VAULT", confirmation });
    entries = [];
    trash = [];
    showMessage("密码库已删除，可以重新创建或恢复备份");
    await renderState();
  } catch (error) {
    showMessage(error.message, true);
  }
}

document.querySelector("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#setup-password").value;
  if (password !== document.querySelector("#setup-confirm").value) {
    showMessage("两次输入的主密码不一致", true);
    return;
  }
  try {
    await request({ type: "CREATE_VAULT", password });
    showMessage("密码库已创建");
    await renderState();
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request({ type: "UNLOCK", password: document.querySelector("#unlock-password").value });
    document.querySelector("#unlock-password").value = "";
    showMessage("");
    await renderState();
  } catch (error) {
    showMessage(error.message, true);
  }
});

ui.lockButton.addEventListener("click", async () => {
  await request({ type: "LOCK" });
  entries = [];
  trash = [];
  showMessage("");
  await renderState();
});

ui.searchInput.addEventListener("input", renderEntries);
ui.sortSelect.addEventListener("change", renderEntries);
document.querySelector("#add-button").addEventListener("click", () => openDialog());
document.querySelector("#dialog-close").addEventListener("click", () => ui.dialog.close());
document.querySelector("#cancel-button").addEventListener("click", () => ui.dialog.close());
document.querySelector("#generate-button").addEventListener("click", () => {
  ui.entryPassword.value = generatePassword();
  setPasswordVisibility(true);
});
ui.togglePasswordButton.addEventListener("click", () => {
  setPasswordVisibility(ui.entryPassword.type === "password");
  ui.entryPassword.focus();
});

document.querySelector("#entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = {
    id: ui.entryId.value || undefined,
    name: ui.entryName.value,
    url: ui.entryUrl.value,
    username: ui.entryUsername.value,
    password: ui.entryPassword.value
  };
  try {
    await request({ type: "SAVE_ENTRY", entry });
    ui.dialog.close();
    await loadVault();
    showMessage("账号已加密保存");
  } catch (error) {
    if (!entry.id && error.message.includes("已存在相同用户名") &&
        confirm("已存在相同用户名，是否更新现有账号？")) {
      try {
        await request({ type: "SAVE_ENTRY", entry: { ...entry, onDuplicate: "update" } });
        ui.dialog.close();
        await loadVault();
        showMessage("已有账号已更新");
        return;
      } catch (updateError) {
        showMessage(updateError.message, true);
        return;
      }
    }
    showMessage(error.message, true);
  }
});

ui.generatorSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {
    length: Number(ui.generatorLength.value),
    uppercase: ui.generatorUppercase.checked,
    lowercase: ui.generatorLowercase.checked,
    numbers: ui.generatorNumbers.checked,
    symbols: ui.generatorSymbols.checked
  };
  if (!settings.uppercase && !settings.lowercase && !settings.numbers && !settings.symbols) {
    showMessage("至少选择一种密码字符类型", true);
    return;
  }
  try {
    const result = await request({ type: "SET_GENERATOR_SETTINGS", settings });
    generatorSettings = PasswordGenerator.normalizeSettings(result.settings);
    showMessage("密码生成规则已保存");
  } catch (error) {
    showMessage(error.message, true);
  }
});

ui.deleteButton.addEventListener("click", async () => {
  if (!confirm("确定把这个账号移到回收站吗？")) return;
  const scrollPosition = window.scrollY;
  try {
    await request({ type: "DELETE_ENTRY", id: ui.entryId.value });
    ui.dialog.close();
    await loadVault();
    showMessage("账号已移到回收站");
  } catch (error) {
    showMessage(error.message, true);
  }
  restoreScrollPosition(scrollPosition);
});

document.querySelector("#csv-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const result = await request({ type: "IMPORT_CSV", text: await file.text() });
    await loadVault();
    showMessage(`导入完成：新增 ${result.added} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条。请删除原始 CSV 文件。`);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#backup-button").addEventListener("click", async () => {
  try {
    const result = await request({ type: "EXPORT_BACKUP" });
    const url = URL.createObjectURL(new Blob([result.text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `password-vault-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage("加密备份已导出");
  } catch (error) {
    showMessage(error.message, true);
  }
});

for (const input of document.querySelectorAll(".backup-input")) {
  input.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await openRestoreDialog(file);
    } catch (error) {
      showMessage(`读取备份失败：${error.message}`, true);
    }
  });
}

document.querySelector("#restore-close").addEventListener("click", () => ui.restoreDialog.close());
document.querySelector("#restore-cancel").addEventListener("click", () => ui.restoreDialog.close());
document.querySelector("#restore-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (currentStatus.initialized && !ui.replaceConfirm.checked) {
    showMessage("请先确认替换当前密码库", true);
    return;
  }
  try {
    const result = await request({
      type: "IMPORT_BACKUP",
      text: backupText,
      password: ui.restorePassword.value,
      confirmReplace: currentStatus.initialized ? ui.replaceConfirm.checked : false
    });
    backupText = "";
    ui.restoreDialog.close();
    showMessage(`备份恢复完成：${result.entries} 个账号，回收站 ${result.trash} 个。`);
    await renderState();
  } catch (error) {
    showMessage(error.message, true);
  }
});

ui.emptyTrashButton.addEventListener("click", async () => {
  if (!confirm("确定永久删除回收站中的全部账号吗？此操作无法撤销。")) return;
  try {
    const result = await request({ type: "EMPTY_TRASH" });
    await loadVault();
    showMessage(`已永久删除 ${result.deleted} 个账号`);
  } catch (error) {
    showMessage(error.message, true);
  }
});

ui.autoLockSelect.addEventListener("change", async () => {
  try {
    await request({ type: "SET_AUTO_LOCK", minutes: Number(ui.autoLockSelect.value) });
    showMessage(`闲置 ${ui.autoLockSelect.value} 分钟后将自动锁定`);
  } catch (error) {
    showMessage(error.message, true);
    await loadVault();
  }
});

document.querySelector("#show-change-password").addEventListener("click", () => {
  show(ui.changePasswordForm, ui.changePasswordForm.classList.contains("hidden"));
});

ui.changePasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const newPassword = document.querySelector("#new-password").value;
  if (newPassword !== document.querySelector("#new-password-confirm").value) {
    showMessage("两次输入的新主密码不一致", true);
    return;
  }
  try {
    await request({
      type: "CHANGE_MASTER_PASSWORD",
      currentPassword: document.querySelector("#current-password").value,
      newPassword
    });
    ui.changePasswordForm.reset();
    show(ui.changePasswordForm, false);
    showMessage("主密码已修改，请更新你的备份");
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#delete-vault-button").addEventListener("click", deleteWholeVault);
document.querySelector("#forgot-delete-button").addEventListener("click", deleteWholeVault);

renderState().catch((error) => showMessage(error.message, true));
