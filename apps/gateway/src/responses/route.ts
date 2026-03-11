import { OpenAPIHono } from "@hono/zod-openapi";

import { responses } from "./responses.js";

import type { ServerTypes } from "@/vars.js";

export const responsesRoute = new OpenAPIHono<ServerTypes>();

responsesRoute.route("/", responses);
