// Sends anything under private/ to a separate private backend, everything else to the main one.
//
// The rule this exists for: a private/ path never resolves to the main library. If no
// private backend is connected, private/ paths are refused outright, so a private file
// can't quietly land where the reader account (and anyone using it) can see it.

export const PRIVATE = "private";

const parts = (p = "") => String(p).split("/").filter((x) => x && x !== ".");
export const isPrivatePath = (p = "") => parts(p)[0]?.toLowerCase() === PRIVATE;

export class SplitBackend {
  constructor({ main, privateBackend = null, unavailable }) {
    if (!main) throw new Error("SplitBackend needs a main backend");
    this.main = main;
    this.priv = privateBackend;
    this.unavailable = unavailable ?? "Private files aren't connected on this machine, so nothing under private/ can be read or written.";
  }

  route(p = "") {
    if (!isPrivatePath(p)) return { backend: this.main, inner: p ?? "", prefix: "" };
    if (!this.priv) throw new Error(this.unavailable);
    return { backend: this.priv, inner: parts(p).slice(1).join("/"), prefix: PRIVATE };
  }

  async list(p = "") {
    const r = this.route(p);
    const items = (await r.backend.list(r.inner)).map((e) => (r.prefix ? { ...e, path: `${PRIVATE}/${e.path}` } : e));
    if (parts(p).length) return items;
    const top = items.filter((e) => !isPrivatePath(e.path));
    if (this.priv) top.push({ path: PRIVATE, type: "folder" });
    return top.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(p) {
    const r = this.route(p);
    return r.backend.read(r.inner);
  }

  async search(query, limit = 10) {
    const found = (await this.main.search(query, limit)).filter((h) => !isPrivatePath(h.path));
    if (this.priv && found.length < limit) {
      const priv = await this.priv.search(query, limit - found.length);
      found.push(...priv.map((h) => ({ ...h, path: `${PRIVATE}/${h.path}` })));
    }
    return found.slice(0, limit);
  }

  async write(p, content) {
    const r = this.route(p);
    if (r.prefix && !r.inner) throw new Error("Give a file name inside private/");
    const result = await r.backend.write(r.inner, content);
    return r.prefix ? { ...result, path: `${PRIVATE}/${result.path}`, private: true } : result;
  }
}
