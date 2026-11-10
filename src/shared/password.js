(function (scope) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    length: 20,
    uppercase: true,
    lowercase: true,
    numbers: true,
    symbols: true
  });

  const CHARACTER_SETS = {
    uppercase: "ABCDEFGHJKLMNPQRSTUVWXYZ",
    lowercase: "abcdefghijkmnopqrstuvwxyz",
    numbers: "23456789",
    symbols: "!@#$%&*+-_="
  };

  function normalizeSettings(input) {
    const requestedLength = Math.trunc(Number(input?.length)) || DEFAULT_SETTINGS.length;
    const length = Math.min(64, Math.max(8, requestedLength));
    const settings = {
      length,
      uppercase: input?.uppercase !== false,
      lowercase: input?.lowercase !== false,
      numbers: input?.numbers !== false,
      symbols: input?.symbols !== false
    };
    if (!settings.uppercase && !settings.lowercase && !settings.numbers && !settings.symbols) {
      return { ...DEFAULT_SETTINGS, length };
    }
    return settings;
  }

  function randomIndex(maximum) {
    const limit = Math.floor(256 / maximum) * maximum;
    const byte = new Uint8Array(1);
    do {
      crypto.getRandomValues(byte);
    } while (byte[0] >= limit);
    return byte[0] % maximum;
  }

  function randomCharacter(characters) {
    return characters[randomIndex(characters.length)];
  }

  function generate(input) {
    const settings = normalizeSettings(input);
    const enabledSets = Object.entries(CHARACTER_SETS)
      .filter(([name]) => settings[name])
      .map(([, characters]) => characters);
    const allCharacters = enabledSets.join("");
    const result = enabledSets.map(randomCharacter);
    while (result.length < settings.length) {
      result.push(randomCharacter(allCharacters));
    }
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = randomIndex(index + 1);
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result.join("");
  }

  scope.PasswordGenerator = { DEFAULT_SETTINGS, generate, normalizeSettings };
})(globalThis);
