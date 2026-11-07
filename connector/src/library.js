export const ROLES = ["reader", "writer"];

const READ_ONLY = "This connector is read-only. Only the leader's plugin can write to the library.";
const isMissing = (err) => err?.code === "ENOENT" || /^No file at/.test(err?.message ?? "");

export function createLibrary({ backend, role }) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
  const writer = () => {
    if (role !== "writer") throw new Error(READ_ONLY);
  };

  // Saves the new text, then reads it back. Append and edit change a file the person never
  // sees whole, so a save that came back different must be reported, never assumed fine.
  const saveChecked = async (p, next) => {
    const result = await backend.write(p, next);
    const back = await backend.read(p);
    if (back !== next) throw new Error(`"${p}" was saved, but the copy read back doesn't match what was sent. Check the file in Drive before writing to it again.`);
    return result;
  };

  return {
    role,
    canWrite: role === "writer",
    list: async (p) => backend.list(p ?? ""),
    read: async (p) => backend.read(p),
    search: async (q, limit) => {
      if (!q || !q.trim()) throw new Error("Search needs some words");
      return backend.search(q.trim(), limit);
    },
    write: async (p, content) => {
      writer();
      return backend.write(p, content);
    },
    append: async (p, text) => {
      writer();
      if (!text) throw new Error("Nothing to add");
      let current = "";
      let created = false;
      try {
        current = await backend.read(p);
      } catch (err) {
        if (!isMissing(err)) throw err;
        created = true;
      }
      const joiner = current && !current.endsWith("\n") ? "\n" : "";
      const result = await saveChecked(p, current + joiner + text);
      return { ...result, added: Buffer.byteLength(text, "utf8"), created };
    },
    edit: async (p, find, replace) => {
      writer();
      if (!find) throw new Error("Say which text to change");
      const current = await backend.read(p);
      const count = current.split(find).length - 1;
      if (count === 0) throw new Error(`That text isn't in "${p}". Nothing was changed.`);
      if (count > 1) throw new Error(`That text appears ${count} times in "${p}". Include more of the words around it so it matches once. Nothing was changed.`);
      const result = await saveChecked(p, current.replace(find, () => replace ?? ""));
      return { ...result, changed: 1 };
    },
  };
}
