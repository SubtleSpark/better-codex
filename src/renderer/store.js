export function createColorStore(storage, key = 'better-codex:v1:colors') {
  let colors = load();

  function load() {
    try {
      const raw = storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persist() {
    storage.setItem(key, JSON.stringify(colors));
  }

  return {
    get(itemKey) {
      return colors[itemKey] || null;
    },

    set(itemKey, color) {
      colors[itemKey] = color;
      persist();
    },

    remove(itemKey) {
      delete colors[itemKey];
      persist();
    },
  };
}
