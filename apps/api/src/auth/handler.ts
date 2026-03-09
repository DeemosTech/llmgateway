import { OpenAPIHono } from "@hono/zod-openapi";

import { apiAuth } from "./config.js";

import type { ServerTypes } from "@/vars.js";

// Create a Hono app for auth routes
export const authHandler = new OpenAPIHono<ServerTypes>();

authHandler.use("*", async (c, next) => {
	const session = await apiAuth.api.getSession({ headers: c.req.raw.headers });

	if (!session) {
		c.set("user", null);
		c.set("session", null);
		return await next();
	}

	c.set("user", session.user);
	c.set("session", session.session);
	return await next();
});

authHandler.on(["POST", "GET", "PUT", "PATCH", "DELETE"], "/auth/*", (c) => {
	// Handle requests that come to /auth/* (direct) or /api/auth/* (via prefix)
	// Check if the URL has /api prefix and rewrite it for better-auth
	let request = c.req.raw;
	const url = new URL(request.url);

	// If the path starts with /api/auth, rewrite it to /auth
	if (url.pathname.startsWith("/api/auth")) {
		url.pathname = url.pathname.replace(/^\/api/, "");
		request = new Request(url.toString(), request);
	}

	return apiAuth.handler(request);
});
