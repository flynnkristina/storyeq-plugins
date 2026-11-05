export const ROLES = ["reader", "writer"];

export function createLibrary({ backend, role }) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(", ")}`);
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
      if (role !== "writer") throw new Error("This connector is read-only. Only the leader's plugin can write to the library.");
      return backend.write(p, content);
    },
  };
}
