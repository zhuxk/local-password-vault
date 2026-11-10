"use strict";

const state = {
  entries: [],
  fillMode: "auto",
  activeInput: null,
  stepUsername: "",
  lastCaptureSignature: "",
  lastCaptureTime: 0,
  autoFillSuppressed: false,
  scanTimer: null,
  burstTimers: [],
  roots: new Set()
};

const filledInputs = new WeakSet();
const observedRoots = new WeakSet();

async function request(message) {
  let timeoutId;
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("扩展响应超时，请重新加载扩展后再试")), 10000);
    });
    const response = await Promise.race([chrome.runtime.sendMessage(message), timeout]);
    if (!response?.ok) {
      throw new Error(response?.error || "操作失败");
    }
    return response.data;
  } finally {
    clearTimeout(timeoutId);
  }
}

function effectivePageUrl() {
  if (/^https?:/i.test(location.href)) return location.href;
  const ancestorOrigin = location.ancestorOrigins?.[0];
  return /^https?:/i.test(ancestorOrigin || "") ? `${ancestorOrigin}/` : location.href;
}

function isUsable(input) {
  if (!(input instanceof HTMLInputElement) || !input.isConnected || input.disabled || input.readOnly) {
    return false;
  }
  const style = getComputedStyle(input);
  if (style.visibility === "hidden" || style.display === "none") {
    return false;
  }
  const rect = input.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function formScope(input) {
  return input.form || input.closest("form") || input.getRootNode();
}

function queryInputs(scope) {
  return Array.from(scope?.querySelectorAll?.("input") || []);
}

function queryAcrossRoots(selector) {
  const matches = [];
  for (const root of state.roots) {
    if (root === document || root.host?.isConnected) {
      matches.push(...root.querySelectorAll(selector));
    }
  }
  return matches;
}

function passwordInputs(scope = null) {
  const candidates = scope
    ? Array.from(scope.querySelectorAll?.('input[type="password"]') || [])
    : queryAcrossRoots('input[type="password"]');
  return candidates.filter((input) => {
    return isUsable(input) && (input.autocomplete || "").toLowerCase() !== "new-password";
  });
}

function usernameScore(input) {
  const autocomplete = (input.autocomplete || "").toLowerCase();
  const type = (input.type || "text").toLowerCase();
  const hint = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
  if (["one-time-code", "current-password", "new-password"].includes(autocomplete) ||
      /(captcha|verify|verification|otp|sms.?code|search|验证码|校验码|短信码|搜索)/.test(hint)) return 0;
  if (autocomplete === "username") return 100;
  if (type === "email") return 90;
  if (type === "tel" && /(mobile|phone|tel|手机|手机号)/.test(hint)) return 80;
  if (["text", "tel", ""].includes(type) &&
      /(user|email|mail|mobile|phone|account|login|用户名|账号|帐号|邮箱|手机)/.test(hint)) return 70;
  return 0;
}

function isLoginTextFallback(input) {
  const type = (input.type || "text").toLowerCase();
  const autocomplete = (input.autocomplete || "").toLowerCase();
  const hint = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
  return ["text", "email", "tel", ""].includes(type) &&
    !["one-time-code", "current-password", "new-password"].includes(autocomplete) &&
    !/(captcha|verify|verification|otp|sms.?code|search|验证码|校验码|短信码|搜索)/.test(hint);
}

function usernameInputs(scope = null) {
  const candidates = scope ? queryInputs(scope) : queryAcrossRoots("input");
  return candidates
    .filter((input) => isUsable(input) && usernameScore(input) > 0)
    .sort((left, right) => usernameScore(right) - usernameScore(left));
}

function findUsernameInput(passwordInput) {
  const scope = formScope(passwordInput);
  const inputs = queryInputs(scope).filter(isUsable);
  const passwordIndex = inputs.indexOf(passwordInput);
  const beforePassword = passwordIndex >= 0 ? inputs.slice(0, passwordIndex) : inputs;
  const explicit = beforePassword
    .filter((input) => usernameScore(input) > 0)
    .sort((left, right) => usernameScore(right) - usernameScore(left))[0];
  return explicit || beforePassword.find(isLoginTextFallback) || null;
}

function findPasswordForInput(input) {
  if (input?.type === "password") {
    return input;
  }
  return passwordInputs(input ? formScope(input) : null)[0] || null;
}

function elementContextHint(input) {
  const parts = [];
  let element = input;
  for (let depth = 0; element && depth < 6; depth += 1) {
    parts.push(
      element.id || "",
      typeof element.className === "string" ? element.className : "",
      element.getAttribute?.("name") || "",
      element.getAttribute?.("role") || "",
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("action") || ""
    );
    element = element.parentElement;
  }
  return parts.join(" ").toLowerCase();
}

function submitControlText(scope) {
  return Array.from(scope?.querySelectorAll?.(
    'button, input[type="submit"], input[type="button"], [role="button"]'
  ) || []).map((control) => {
    return `${control.textContent || ""} ${control.value || ""} ${control.title || ""} ${control.getAttribute("aria-label") || ""}`;
  }).join(" ").toLowerCase();
}

function loginContextScore(input, usernameOnly = false) {
  const scope = formScope(input);
  const pageHint = `${location.pathname} ${document.title}`.toLowerCase();
  const contextHint = elementContextHint(input);
  const actionText = submitControlText(scope);
  const loginPattern = /(log[\s_-]?in|sign[\s_-]?in|signin|authentication|auth-form|登录|登陆)/i;
  const configPattern = /(config|settings?|preferences?|profile|setup|connection|database|proxy|配置|设置|参数|连接|数据库|代理)/i;
  let score = 0;
  if (loginPattern.test(pageHint)) score += 3;
  if (loginPattern.test(contextHint)) score += 4;
  if (/(log[\s_-]?in|sign[\s_-]?in|登录|登陆)/i.test(actionText)) score += 4;
  if (/(next|continue|下一步|继续)/i.test(actionText)) score += 2;
  if (configPattern.test(pageHint)) score -= 4;
  if (configPattern.test(contextHint)) score -= 5;
  if (/(save|apply|update|保存|应用|更新)/i.test(actionText)) score -= 4;
  const autocomplete = (input.autocomplete || "").toLowerCase();
  if ((!usernameOnly && autocomplete === "current-password") ||
      (usernameOnly && autocomplete === "username")) score += 3;
  if (usernameOnly) {
    if (usernameScore(input) >= 90) score += 1;
    else if (usernameScore(input) > 0) score += 2;
  } else {
    const explicitUsername = queryInputs(scope).some((candidate) => {
      return candidate !== input && isUsable(candidate) && usernameScore(candidate) > 0;
    });
    if (explicitUsername) score += 2;
  }
  return score;
}

function isLoginPasswordInput(input) {
  return passwordInputs(formScope(input)).length === 1 && loginContextScore(input) >= 4;
}

function isUsernameOnlyLoginInput(input) {
  return passwordInputs(formScope(input)).length === 0 && loginContextScore(input, true) >= 4;
}

function selectedEntry(usernameInput) {
  const typedUsername = usernameInput?.value.trim() || state.stepUsername;
  return state.entries.find((entry) => entry.username === typedUsername) || state.entries[0] || null;
}

function fillCredential(credential, targetInput = null) {
  const target = targetInput && isUsable(targetInput) ? targetInput : null;
  const passwordInput = target?.type === "password"
    ? target
    : findPasswordForInput(target) || passwordInputs()[0] || null;
  const usernameInput = passwordInput
    ? findUsernameInput(passwordInput)
    : target && usernameScore(target) > 0 ? target : usernameInputs()[0] || null;
  if (!passwordInput && !usernameInput) {
    throw new Error("当前页面没有找到可填写的登录输入框");
  }
  if (usernameInput) {
    setInputValue(usernameInput, credential.username);
    filledInputs.add(usernameInput);
    state.stepUsername = credential.username;
  }
  if (passwordInput) {
    setInputValue(passwordInput, credential.password);
    filledInputs.add(passwordInput);
    passwordInput.focus();
  } else {
    usernameInput.focus();
  }
  return { usernameFilled: Boolean(usernameInput), passwordFilled: Boolean(passwordInput) };
}

function removeElement(id) {
  document.getElementById(id)?.remove();
}

function showToast(text, error = false) {
  removeElement("lpv-toast");
  const toast = document.createElement("div");
  toast.id = "lpv-toast";
  toast.className = error ? "lpv-toast lpv-error" : "lpv-toast";
  toast.textContent = text;
  document.documentElement.append(toast);
  setTimeout(() => toast.remove(), 2800);
}

function positionFillButton() {
  const button = document.getElementById("lpv-field-button");
  const input = state.activeInput;
  if (!button || !input || !isUsable(input)) {
    button?.remove();
    removeElement("lpv-account-menu");
    return;
  }
  const rect = input.getBoundingClientRect();
  // content.css 用 `all: initial !important` 覆盖了页面样式，
  // 而 `!important` 的优先级高于普通内联样式，
  // 因此定位必须用 setProperty 显式声明 important，否则会被重置为初始值。
  button.style.setProperty("top", `${Math.max(4, rect.top + (rect.height - 28) / 2)}px`, "important");
  const left = rect.right + 42 <= window.innerWidth ? rect.right + 6 : rect.right - 38;
  button.style.setProperty("left", `${Math.max(4, left)}px`, "important");
}

function hideAccountMenu() {
  removeElement("lpv-account-menu");
}

function showAccountMenu() {
  hideAccountMenu();
  const button = document.getElementById("lpv-field-button");
  if (!button || !state.entries.length) return;
  const menu = document.createElement("div");
  menu.id = "lpv-account-menu";
  const heading = document.createElement("div");
  heading.className = "lpv-menu-heading";
  heading.textContent = "选择要填充的账号";
  menu.append(heading);
  for (const entry of state.entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lpv-account-item";
    const username = document.createElement("strong");
    username.textContent = entry.username;
    const site = document.createElement("span");
    site.textContent = entry.siteKey;
    item.append(username, site);
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      try {
        fillCredential(entry, state.activeInput);
        void request({ type: "TOUCH" }).catch(() => undefined);
        hideAccountMenu();
        showToast("账号密码已填充");
      } catch (error) {
        showToast(error.message, true);
      }
    });
    menu.append(item);
  }
  document.documentElement.append(menu);
  const rect = button.getBoundingClientRect();
  const width = 280;
  menu.style.setProperty(
    "left",
    `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width))}px`,
    "important"
  );
  const height = Math.min(260, 42 + state.entries.length * 54);
  menu.style.setProperty(
    "top",
    `${rect.bottom + height + 6 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)}px`,
    "important"
  );
}

function showFillButton(input) {
  if (state.fillMode === "disabled" || !state.entries.length || !input || !isUsable(input)) return;
  state.activeInput = input;
  let button = document.getElementById("lpv-field-button");
  if (!button) {
    button = document.createElement("button");
    button.id = "lpv-field-button";
    button.type = "button";
    button.title = "使用本地密码匣填充";
    button.setAttribute("aria-label", "使用本地密码匣填充");
    button.textContent = "钥⌄";
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.getElementById("lpv-account-menu") ? hideAccountMenu() : showAccountMenu();
    });
    document.documentElement.append(button);
  }
  positionFillButton();
}

function tryAutomaticFill(input) {
  if (state.fillMode !== "auto" || state.autoFillSuppressed || filledInputs.has(input) ||
      input.value || !state.entries.length) {
    return false;
  }
  let entry;
  if (input.type === "password") {
    if (!isLoginPasswordInput(input)) return false;
    entry = selectedEntry(findUsernameInput(input));
  } else {
    if (!isUsernameOnlyLoginInput(input)) return false;
    entry = selectedEntry(input);
  }
  if (!entry) return false;
  fillCredential(entry, input);
  return true;
}

function scanLoginFields() {
  discoverOpenRoots();
  if (state.fillMode === "disabled" || !state.entries.length) {
    removeElement("lpv-field-button");
    hideAccountMenu();
    return;
  }
  const passwords = passwordInputs();
  const usernames = usernameInputs();
  for (const input of passwords.length ? passwords : usernames.slice(0, 1)) {
    tryAutomaticFill(input);
  }
  if (!state.activeInput || !isUsable(state.activeInput)) {
    state.activeInput = passwords[0] || usernames[0] || null;
  }
  if (state.activeInput) showFillButton(state.activeInput);
}

function scheduleScan() {
  clearTimeout(state.scanTimer);
  state.scanTimer = setTimeout(scanLoginFields, 100);
}

function scheduleScanBurst() {
  for (const timer of state.burstTimers) clearTimeout(timer);
  state.burstTimers = [0, 180, 600].map((delay) => setTimeout(scanLoginFields, delay));
}

function usernameCandidate(source) {
  const scope = source?.closest?.("form") || source?.getRootNode?.() || document;
  return usernameInputs(scope).find((input) => input.value.trim()) || null;
}

function loginCandidate(source) {
  const scope = source?.closest?.("form") || source?.getRootNode?.() || document;
  const passwords = passwordInputs(scope).filter((input) => input.value);
  if (passwords.length !== 1 || !isLoginPasswordInput(passwords[0])) return null;
  const values = new Set(passwords.map((input) => input.value));
  if (values.size !== 1) return null;
  const username = findUsernameInput(passwords[0])?.value.trim() || state.stepUsername || "";
  return { name: document.title, url: effectivePageUrl(), username, password: passwords[0].value };
}

async function captureLogin(source) {
  if (state.fillMode === "disabled") return;
  const candidate = loginCandidate(source);
  if (!candidate) {
    const usernameInput = usernameCandidate(source);
    if (usernameInput && isUsernameOnlyLoginInput(usernameInput)) {
      state.stepUsername = usernameInput.value.trim();
      await request({
        type: "CAPTURE_STEP_USERNAME",
        credential: { url: effectivePageUrl(), username: state.stepUsername }
      }).catch(() => undefined);
    }
    return;
  }
  const signature = `${candidate.username}\n${candidate.password}`;
  const now = Date.now();
  if (signature === state.lastCaptureSignature && now - state.lastCaptureTime < 1500) return;
  state.lastCaptureSignature = signature;
  state.lastCaptureTime = now;
  try {
    const result = await request({ type: "CAPTURE_CREDENTIAL", credential: candidate });
    syncSavePrompt(result);
  } catch (_error) {
    // 页面跳转不影响后台已经收到的登录信息。
  }
}

function syncSavePrompt(result) {
  if (!result?.pending || result.action === "none" || result.action === "locked") {
    removeElement("lpv-save-prompt");
    return;
  }
  showSavePrompt(result);
}

function showSavePrompt(result) {
  if (!result?.pending) return;
  removeElement("lpv-save-prompt");
  const prompt = document.createElement("section");
  prompt.id = "lpv-save-prompt";
  const title = document.createElement("strong");
  title.textContent = result.action === "update" ? "更新这个账号的密码？" : "保存这个账号密码？";
  const detail = document.createElement("span");
  const site = result.pending.name && result.pending.name !== result.pending.siteKey
    ? `${result.pending.name} · ${result.pending.siteKey}`
    : result.pending.siteKey;
  detail.textContent = `${site} · ${result.pending.username}`;
  const error = document.createElement("span");
  error.className = "lpv-save-error";
  const actions = document.createElement("div");
  actions.className = "lpv-save-actions";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "lpv-secondary";
  dismiss.textContent = "不保存";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "lpv-primary";
  save.textContent = result.action === "update" ? "更新" : "保存";
  dismiss.addEventListener("click", async () => {
    await request({ type: "DISMISS_PENDING_CREDENTIAL", id: result.pending.id }).catch(() => undefined);
    prompt.remove();
  });
  save.addEventListener("click", async () => {
    save.disabled = true;
    error.textContent = "";
    try {
      await request({ type: "SAVE_PENDING_CREDENTIAL", id: result.pending.id });
      prompt.remove();
      showToast(result.action === "update" ? "密码已更新" : "账号密码已保存");
      await loadSiteEntries();
    } catch (saveError) {
      error.textContent = saveError.message;
      if (saveError.message.includes("解锁")) {
        const unlock = document.createElement("button");
        unlock.type = "button";
        unlock.className = "lpv-unlock-link";
        unlock.textContent = "打开密码管理器解锁";
        unlock.addEventListener("click", () => request({ type: "OPEN_MANAGER" }).catch(() => undefined));
        error.append(" ", unlock);
      }
    } finally {
      save.disabled = false;
    }
  });
  actions.append(dismiss, save);
  prompt.append(title, detail, error, actions);
  document.documentElement.append(prompt);
}

async function loadSiteEntries() {
  try {
    const pageUrl = effectivePageUrl();
    const result = await request({ type: "CURRENT_ENTRIES", url: pageUrl });
    state.entries = result.entries;
    state.fillMode = result.fillMode;
    const step = await request({ type: "GET_STEP_USERNAME", url: pageUrl });
    state.stepUsername = step.username || "";
    scheduleScan();
  } catch (_error) {
    state.entries = [];
    removeElement("lpv-field-button");
    hideAccountMenu();
  }
}

async function restoreSavePrompt() {
  try {
    const result = await request({ type: "GET_PENDING_CREDENTIAL", url: effectivePageUrl() });
    syncSavePrompt(result);
  } catch (_error) {
    // 没有待保存信息时不影响网页。
  }
}

function eventTarget(event) {
  return event.composedPath?.()[0] || event.target;
}

function handleFocus(event) {
  const target = eventTarget(event);
  if (!(target instanceof HTMLInputElement) || state.fillMode === "disabled") return;
  if (target.type === "password" || usernameScore(target) > 0) {
    tryAutomaticFill(target);
    showFillButton(target);
  }
}

function handleUserInput(event) {
  const target = eventTarget(event);
  if (event.isTrusted && target instanceof HTMLInputElement && filledInputs.has(target)) {
    state.autoFillSuppressed = true;
  }
}

function handleClick(event) {
  const target = eventTarget(event);
  const submitter = target?.closest?.('button:not([type]), button[type="submit"], input[type="submit"]');
  if (submitter) void captureLogin(submitter);
  if (!target?.closest?.("#lpv-account-menu") && !target?.closest?.("#lpv-field-button")) {
    hideAccountMenu();
  }
  if (state.entries.length && state.fillMode !== "disabled" &&
      target?.closest?.('button, a, label, [role="button"], [role="tab"]') &&
      !target.closest?.('[id^="lpv-"]')) {
    scheduleScanBurst();
  }
}

function observeRoot(root) {
  if (observedRoots.has(root)) return;
  observedRoots.add(root);
  state.roots.add(root);
  if (root instanceof ShadowRoot) {
    root.addEventListener("focusin", handleFocus, true);
    root.addEventListener("input", handleUserInput, true);
    root.addEventListener("submit", (event) => void captureLogin(eventTarget(event)), true);
    root.addEventListener("click", handleClick, true);
  }
  const observer = new MutationObserver((mutations) => {
    let relevant = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          discoverOpenRoots(node);
          if (node.matches("input, form") || node.querySelector("input, form")) relevant = true;
        }
      }
    }
    if (relevant && state.entries.length && state.fillMode !== "disabled") scheduleScan();
  });
  observer.observe(root, { childList: true, subtree: true });
}

function discoverOpenRoots(start = document) {
  if (start === document || start instanceof ShadowRoot) observeRoot(start);
  const elements = start.querySelectorAll?.("*") || [];
  for (const element of elements) {
    if (element.shadowRoot) discoverOpenRoots(element.shadowRoot);
  }
  if (start instanceof Element && start.shadowRoot) discoverOpenRoots(start.shadowRoot);
}

document.addEventListener("focusin", handleFocus, true);
document.addEventListener("input", handleUserInput, true);
document.addEventListener("submit", (event) => void captureLogin(eventTarget(event)), true);
document.addEventListener("click", handleClick, true);
window.addEventListener("scroll", positionFillButton, true);
window.addEventListener("resize", positionFillButton);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "VAULT_UNLOCKED" || message?.type === "VAULT_CHANGED") {
    if (message.type === "VAULT_UNLOCKED") state.autoFillSuppressed = false;
    void loadSiteEntries();
    void restoreSavePrompt();
    return false;
  }
  if (message?.type === "VAULT_LOCKED") {
    state.entries = [];
    state.activeInput = null;
    state.stepUsername = "";
    removeElement("lpv-field-button");
    removeElement("lpv-save-prompt");
    hideAccountMenu();
    return false;
  }
  if (message?.type !== "FILL_CREDENTIAL") return false;
  try {
    sendResponse({ ok: true, data: fillCredential(message.credential || {}) });
  } catch (error) {
    sendResponse({ ok: false, error: error.message || "填充失败" });
  }
  return false;
});

discoverOpenRoots();
void loadSiteEntries();
void restoreSavePrompt();
