import { HTTPException } from "hono/http-exception";

import { extractCustomHeaders } from "@/chat/tools/extract-custom-headers.js";
import { parseModelInput } from "@/chat/tools/parse-model-input.js";
import { resolveModelInfo } from "@/chat/tools/resolve-model-info.js";
import { validateSource } from "@/chat/tools/validate-source.js";
import {
	findApiKeyByToken,
	findOrganizationById,
	findProjectById,
} from "@/lib/cached-queries.js";

import {
	shortid,
	type ApiKey,
	type Organization,
	type Project,
} from "@llmgateway/db";

import type { ModelDefinition, Provider } from "@llmgateway/models";
import type { Context } from "hono";

export interface ResolvedRequestContext {
	requestId: string;
	token: string;
	apiKey: ApiKey;
	project: Project;
	organization: Organization;
	requestedModel: string;
	requestedProvider: Provider | undefined;
	customProviderName: string | undefined;
	modelInfo: ModelDefinition;
	source: string | undefined;
	userAgent: string | undefined;
	debugMode: boolean;
	customHeaders: Record<string, string>;
}

export function extractAuthToken(c: Context): string {
	const auth = c.req.header("Authorization");
	const xApiKey = c.req.header("x-api-key");

	if (auth) {
		const split = auth.split("Bearer ");
		if (split.length === 2 && split[1]) {
			return split[1];
		}
	}

	if (xApiKey) {
		return xApiKey;
	}

	throw new HTTPException(401, {
		message:
			"Unauthorized: No API key provided. Expected 'Authorization: Bearer your-api-token' header or 'x-api-key: your-api-token' header",
	});
}

export async function resolveRequestContext(
	c: Context,
	modelInput: string,
): Promise<ResolvedRequestContext> {
	const requestId = c.req.header("x-request-id") ?? shortid(40);
	c.header("x-request-id", requestId);

	const token = extractAuthToken(c);
	const apiKey = await findApiKeyByToken(token);

	if (!apiKey || apiKey.status !== "active") {
		throw new HTTPException(401, {
			message:
				"Unauthorized: Invalid LLMGateway API token. Please make sure the token is not deleted or disabled.",
		});
	}

	if (apiKey.usageLimit && Number(apiKey.usage) >= Number(apiKey.usageLimit)) {
		throw new HTTPException(401, {
			message: "Unauthorized: LLMGateway API key reached its usage limit.",
		});
	}

	const project = await findProjectById(apiKey.projectId);
	if (!project) {
		throw new HTTPException(500, {
			message: "Could not find project",
		});
	}

	if (project.status === "deleted") {
		throw new HTTPException(410, {
			message: "Project has been archived and is no longer accessible",
		});
	}

	const organization = await findOrganizationById(project.organizationId);
	if (!organization) {
		throw new HTTPException(500, {
			message: "Could not find organization",
		});
	}

	const parseResult = parseModelInput(modelInput);
	const modelInfoResult = resolveModelInfo(
		parseResult.requestedModel,
		parseResult.requestedProvider,
	);

	const source = validateSource(
		c.req.header("x-source"),
		c.req.header("HTTP-Referer"),
	);
	const userAgent = c.req.header("User-Agent") ?? undefined;
	const debugMode =
		c.req.header("x-debug") === "true" ||
		process.env.FORCE_DEBUG_MODE === "true" ||
		process.env.NODE_ENV !== "production";
	const customHeaders = extractCustomHeaders(c);

	return {
		requestId,
		token,
		apiKey,
		project,
		organization,
		requestedModel: parseResult.requestedModel,
		requestedProvider: modelInfoResult.requestedProvider,
		customProviderName: parseResult.customProviderName,
		modelInfo: modelInfoResult.modelInfo,
		source,
		userAgent,
		debugMode,
		customHeaders,
	};
}
