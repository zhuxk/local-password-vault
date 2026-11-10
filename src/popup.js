"use strict";

const elements = {
  pageTitle: document.querySelector("#page-title"),
  siteAddress: document.querySelector("#site-address"),
  message: document.querySelector("#message"),
  setupView: document.querySelector("#setup-view"),
  unlockView: document.querySelector("#unlock-view"),
  vaultView: document.querySelector("#vault-view"),
  siteView: document.querySelector("#site-view"),
  unsupported: document.querySelector("#unsupported"),
  lockButton: document.querySelector("#lock-button"),
  accountList: document.querySelector("#account-list"),
  emptyState: document.querySelector("#empty-state"),
  showAddButton: document.querySelector("#show-add-button"),
  entryForm: document.querySelector("#entry-form"),
  entryUrl: document.querySelector("#entry-url"),
  entryUsername: document.querySelector("#entry-username"),
  entryPassword: document.querySelector("#entry-password"),
  fillMode: document.querySelector("#fill-mode")
};

let activeTab = null;
let currentSiteKey = "";
let currentDefaultEntryId = "";
let generatorSettings = { ...PasswordGenerator.DEFAULT_SETTINGS };

function show(element, visible = true) {
  element.classList.toggle("hidden", !visible);
}

function showMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
  show(elements.message, Boolean(text));
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "操作失败");
  }
  return response.data;
}

async function queryActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function usableUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function randomPassword() {
  return PasswordGenerator.generate(generatorSettings);
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

async function render() {
  showMessage("");
  const state = await request({ type: "STATUS" });
  show(elements.setupView, !state.initialized);
  show(elements.unlockView, state.initialized && !state.unlocked);
  show(elements.vaultView, state.unlocked);
  show(elements.lockButton, state.unlocked);

  if (!state.initialized) {
    elements.pageTitle.textContent = "首次使用";
    show(elements.siteAddress, false);
    return;
  }
  if (!state.unlocked) {
    elements.pageTitle.textContent = "需要解锁";
    show(elements.siteAddress, false);
    return;
  }

  activeTab = await queryActiveTab();
  if (!usableUrl(activeTab?.url)) {
    elements.pageTitle.textContent = "本地密码匣";
    show(elements.siteAddress, false);
    show(elements.unsupported);
    show(elements.siteView, false);
    return;
  }

  show(elements.unsupported, false);
  show(elements.siteView);
  const result = await request({ type: "CURRENT_ENTRIES", url: activeTab.url });
  currentSiteKey = result.siteKey;
  currentDefaultEntryId = result.defaultEntryId;
  generatorSettings = PasswordGenerator.normalizeSettings(result.generatorSettings);
  elements.pageTitle.textContent = activeTab.title || result.siteKey;
  elements.siteAddress.textContent = result.siteKey;
  show(elements.siteAddress);
  elements.entryUrl.value = activeTab.url;
  elements.fillMode.value = result.fillMode;
  renderAccounts(result.entries);
}

function renderAccounts(entries) {
  elements.accountList.replaceChildren();
  show(elements.emptyState, entries.length === 0);
  entries.forEach((entry, index) => {
    const card = document.createElement("article");
    card.className = "account-card";
    const detail = document.createElement("div");
    detail.className = "account-detail";
    const heading = document.createElement("div");
    heading.className = "account-heading";
    const username = document.createElement("p");
    username.className = "account-name";
    username.textContent = entry.username;
    heading.append(username);
    const isDefault = currentDefaultEntryId === entry.id;
    if (isDefault || (!currentDefaultEntryId && index === 0)) {
      const badge = document.createElement("span");
      badge.className = "default-badge";
      badge.textContent = isDefault ? "默认账号" : "自动默认";
      heading.append(badge);
    }
    detail.append(heading);
    const url = document.createElement("p");
    url.className = "account-url";
    url.textContent = entry.hostname;
    detail.append(url);

    const actions = document.createElement("div");
    actions.className = "account-actions";
    const fill = document.createElement("button");
    fill.type = "button";
    fill.textContent = "填充";
    fill.addEventListener("click", () => fillEntry(entry));
    const copyAccountButton = document.createElement("button");
    copyAccountButton.type = "button";
    copyAccountButton.textContent = "复制账号";
    copyAccountButton.title = "复制账号";
    copyAccountButton.addEventListener("click", () => copyToClipboard(entry.username, "账号"));
    const copyPasswordButton = document.createElement("button");
    copyPasswordButton.type = "button";
    copyPasswordButton.textContent = "复制密码";
    copyPasswordButton.title = "复制密码";
    copyPasswordButton.addEventListener("click", () => copyToClipboard(entry.password, "密码"));
    actions.append(fill, copyAccountButton, copyPasswordButton);
    if (!isDefault) {
      const setDefaultButton = document.createElement("button");
      setDefaultButton.type = "button";
      setDefaultButton.textContent = "设为默认";
      setDefaultButton.addEventListener("click", () => setDefaultEntry(entry.id));
      actions.append(setDefaultButton);
    }
    card.append(detail, actions);
    elements.accountList.append(card);
  });
}

async function setDefaultEntry(entryId) {
  try {
    await request({ type: "SET_DEFAULT_ENTRY", siteKey: currentSiteKey, entryId });
    await render();
    showMessage("默认账号已更新");
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function fillEntry(entry) {
  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "FILL_CREDENTIAL",
      credential: { username: entry.username, password: entry.password }
    });
    if (!response?.ok) {
      throw new Error(response?.error || "填充失败");
    }
    window.close();
  } catch (error) {
    showMessage(error.message || "当前页面无法填充", true);
  }
}

document.querySelector("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#setup-password").value;
  const confirm = document.querySelector("#setup-confirm").value;
  if (password !== confirm) {
    showMessage("两次输入的主密码不一致", true);
    return;
  }
  try {
    await request({ type: "CREATE_VAULT", password });
    await render();
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request({ type: "UNLOCK", password: document.querySelector("#unlock-password").value });
    document.querySelector("#unlock-password").value = "";
    await render();
  } catch (error) {
    showMessage(error.message, true);
  }
});

elements.lockButton.addEventListener("click", async () => {
  await request({ type: "LOCK" });
  await render();
});

elements.fillMode.addEventListener("change", async () => {
  try {
    await request({ type: "SET_SITE_MODE", url: activeTab.url, fillMode: elements.fillMode.value });
    showMessage("当前网站的填充方式已更新");
  } catch (error) {
    showMessage(error.message, true);
    await render();
  }
});

elements.showAddButton.addEventListener("click", () => {
  show(elements.entryForm);
  show(elements.showAddButton, false);
  elements.entryUsername.focus();
});

document.querySelector("#cancel-add-button").addEventListener("click", () => {
  show(elements.entryForm, false);
  show(elements.showAddButton);
});

document.querySelector("#generate-button").addEventListener("click", () => {
  elements.entryPassword.value = randomPassword();
  elements.entryPassword.type = "text";
});

elements.entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = {
    name: activeTab?.title || "",
    url: elements.entryUrl.value,
    username: elements.entryUsername.value,
    password: elements.entryPassword.value
  };
  try {
    await request({ type: "SAVE_ENTRY", entry });
    elements.entryUsername.value = "";
    elements.entryPassword.value = "";
    elements.entryPassword.type = "password";
    show(elements.entryForm, false);
    show(elements.showAddButton);
    await render();
    showMessage("账号已加密保存");
  } catch (error) {
    if (error.message.includes("已存在相同用户名") &&
        confirm("已存在相同用户名，是否更新现有账号？")) {
      try {
        await request({ type: "SAVE_ENTRY", entry: { ...entry, onDuplicate: "update" } });
        elements.entryUsername.value = "";
        elements.entryPassword.value = "";
        elements.entryPassword.type = "password";
        show(elements.entryForm, false);
        show(elements.showAddButton);
        await render();
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

document.querySelector("#manager-button").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

render().catch((error) => showMessage(error.message, true));
