// The hosted library connector. One Worker is both the sign-in server and three separate
// MCP addresses (team, leader, eval bot). Each address is its own OAuth "resource", so a token
// issued for one address is refused at the other two: a team member's sign-in can never be
// replayed against the leader's address. Who may use each address is checked at sign-in
// (access-handler.ts) and again on every request (here).
//
// Sign-in itself is Cloudflare Access (with Google, or whatever login methods the Access
// account has), reached through an "Access for SaaS" OIDC app. This Worker never sees a
// password. Google service-account keys live only as Worker secrets.

import { OAuthAuthorizationServer, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { handleAccessRequest } from "./access-handler";
import { createServer } from "./library-mcp";
import { baseUrl, mayUse, paths, resourceFor, type RoleName } from "./roles";
import type { Props } from "./workers-oauth-utils";

const ROLES: RoleName[] = ["team", "leader", "evalbot"];

type Built = {
  auth: OAuthAuthorizationServer<Env>;
  resources: { role: RoleName; path: string; server: OAuthResourceServer<Env, Props> }[];
};
let built: Built | undefined;

export function authServer(env: Env) {
  return build(env).auth;
}

function build(env: Env): Built {
  if (built) return built;
  const issuer = baseUrl(env);
  const auth = new OAuthAuthorizationServer<Env>({
    issuer,
    resources: ROLES.map((r) => resourceFor(env, r)),
    authorizeEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    clientRegistrationEndpoint: `${issuer}/register`,
  });

  const resources = ROLES.map((role) => {
    const path = paths(env)[role];
    const mcp = createMcpHandler(
      () => {
        const props = getMcpAuthContext()?.props as Props | undefined;
        return createServer(env, role, props?.email ?? "");
      },
      { route: path },
    );
    const server = new OAuthResourceServer<Env, Props>({
      resourceMetadata: { resource: resourceFor(env, role), authorization_servers: [issuer] },
      validateToken: (e) => (resource, token) => auth.validateToken(resource, token, e),
      handler: {
        fetch(request: Request, e: Env, ctx: any) {
          const email = (ctx.props as Props | undefined)?.email;
          if (!mayUse(e, role, email)) {
            return new Response("This account isn't allowed on this address.", { status: 403 });
          }
          return mcp(request, e, ctx);
        },
      },
    });
    return { role, path, server };
  });

  built = { auth, resources };
  return built;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { auth, resources } = build(env);

    // The sign-in pages this Worker owns: the consent screen and Access's return trip.
    if (pathname === "/authorize" || pathname === "/callback") {
      return handleAccessRequest(request, env, ctx);
    }

    // Each address, plus the metadata Claude reads to discover how to sign in to it.
    for (const { path, server } of resources) {
      if (
        pathname === path ||
        pathname.startsWith(`${path}/`) ||
        pathname === `/.well-known/oauth-protected-resource${path}`
      ) {
        return server.fetch(request, env, ctx);
      }
    }

    // Everything else that is OAuth's own: /token, /register, server metadata.
    return auth.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
