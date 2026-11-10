(function (scope) {
  "use strict";

  function parseRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\n") {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }

    if (field || row.length) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
    }
    return rows;
  }

  function findColumn(headers, names) {
    return headers.findIndex((header) => names.includes(header.trim().toLowerCase()));
  }

  function parsePasswordCsv(text) {
    const rows = parseRows(String(text || "").replace(/^\uFEFF/, ""));
    if (rows.length < 2) {
      throw new Error("CSV 文件中没有可导入的密码");
    }

    const headers = rows[0];
    const urlIndex = findColumn(headers, ["url", "website", "网址"]);
    const usernameIndex = findColumn(headers, ["username", "user", "用户名"]);
    const passwordIndex = findColumn(headers, ["password", "密码"]);
    const nameIndex = findColumn(headers, ["name", "title", "名称"]);
    if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) {
      throw new Error("CSV 必须包含 url、username、password 列");
    }

    return rows.slice(1).map((columns, index) => ({
      line: index + 2,
      name: nameIndex >= 0 ? columns[nameIndex] || "" : "",
      url: columns[urlIndex] || "",
      username: columns[usernameIndex] || "",
      password: columns[passwordIndex] || ""
    }));
  }

  scope.PasswordCsv = { parsePasswordCsv };
})(globalThis);
