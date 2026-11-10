(function (scope) {
  "use strict";

  function normalizeHostname(hostname) {
    return String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  }

  function isIpAddress(hostname) {
    if (hostname.includes(":")) {
      return true;
    }
    const parts = hostname.split(".");
    return parts.length === 4 && parts.every((part) => {
      const number = Number(part);
      return /^\d{1,3}$/.test(part) && number >= 0 && number <= 255;
    });
  }

  function registrableDomain(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized || normalized === "localhost" || isIpAddress(normalized)) {
      return normalized;
    }

    const parsed = globalThis.psl?.parse(normalized);
    return parsed && !parsed.error && parsed.domain ? parsed.domain : normalized;
  }

  function canonicalHostname(hostname) {
    const normalized = normalizeHostname(hostname);
    const root = registrableDomain(normalized);
    return normalized === `www.${root}` ? root : normalized;
  }

  function ipEndpoint(url, hostname) {
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const formattedHostname = hostname.includes(":") && !hostname.startsWith("[")
      ? `[${hostname}]`
      : hostname;
    return `${formattedHostname}:${port}`;
  }

  function parseWebsite(value) {
    const input = String(value || "").trim();
    if (!input) {
      throw new Error("请输入网址");
    }

    let url;
    try {
      url = new URL(input.includes("://") ? input : `https://${input}`);
    } catch (_error) {
      throw new Error("网址格式不正确");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("只支持 HTTP 或 HTTPS 网址");
    }

    const hostname = normalizeHostname(url.hostname);
    const ipAddress = isIpAddress(hostname);
    const siteKey = ipAddress ? ipEndpoint(url, hostname) : canonicalHostname(hostname);
    return {
      url: url.href,
      hostname: ipAddress ? siteKey : hostname,
      siteKey,
      groupKey: ipAddress ? hostname : registrableDomain(hostname)
    };
  }

  scope.PasswordDomain = {
    canonicalHostname,
    normalizeHostname,
    parseWebsite,
    registrableDomain
  };
})(globalThis);
