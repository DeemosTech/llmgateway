import { OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { app } from "@/app.js";
import { extractErrorCause } from "@/chat/tools/extract-error-cause.js";
import { resolveProviderContext } from "@/chat/tools/resolve-provider-context.js";
import {
	getErrorType,
	MAX_RETRIES,
	selectNextProvider,
	shouldRetryRequest,
	type RoutingAttempt,
} from "@/chat/tools/retry-with-fallback.js";
import { validateModelCapabilities } from "@/chat/tools/validate-model-capabilities.js";
import { executeNonStreamingAttempt } from "@/common/execute-non-streaming-attempt.js";
import { processNonStreamingProviderResponse } from "@/common/process-non-streaming-provider-response.js";
import { resolveRequestContext } from "@/common/resolve-request-context.js";
import {
	convertToChatCompletionsRequest,
	convertToResponsesResponse,
	createDirectResponsesArtifacts,
	createDirectResponsesBaseLogEntry,
	forwardRequestHeaders,
	normalizeResponsesApiResponse,
} from "@/common/responses.js";
import { reportKeySuccess } from "@/lib/api-key-health.js";
import { throwIamException, validateModelAccess } from "@/lib/iam.js";
import { calculateDataStorageCost, insertLog } from "@/lib/logs.js";

import { shortid } from "@llmgateway/db";
import { logger } from "@llmgateway/logger";

import type { ServerTypes } from "@/vars.js";
import type { ProviderModelMapping } from "@llmgateway/models";
import type { Context } from "hono";

// ============================================
// Zod Schemas for Responses API
// ============================================

// Reasoning Config
const reasoningConfigSchema = z
	.object({
		effort: z
			.enum(["none", "minimal", "low", "medium", "high", "xhigh"])
			.optional(),
		max_tokens: z.number().int().positive().optional(),
	})
	.optional();

// Text Config (for structured outputs) - use the same pattern as completions.ts
const textConfigSchema = z
	.object({
		format: z
			.union([
				z.object({
					type: z.enum(["text", "json_object"]),
				}),
				z.object({
					type: z.literal("json_schema"),
					name: z.string(),
					description: z.string().optional(),
					schema: z.record(z.any()),
					strict: z.boolean().optional(),
				}),
			])
			.optional(),
	})
	.optional();

// Tool definitions - flexible types for compatibility
const toolChoiceSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	z.literal("required"),
	z.object({
		type: z.literal("function"),
		name: z.string(),
	}),
	z.any(),
]);

// Main Responses API Request Schema - make it flexible to accept various formats
const responsesRequestSchema = z
	.object({
		model: z.string().openapi({
			description: "Model ID used to generate the response.",
			example: "gpt-5",
		}),
		input: z
			.union([z.string(), z.array(z.any()), z.undefined()])
			.optional()
			.openapi({
				description:
					"Text, image, or audio input to the model. Can be a string or array of input items.",
			}),
		instructions: z
			.union([z.string(), z.array(z.any()), z.undefined()])
			.optional()
			.openapi({
				description:
					"A system (or developer) message inserted into the model's context.",
			}),
		temperature: z.number().nullable().optional().openapi({
			description: "What sampling temperature to use, between 0 and 2.",
			example: 0.7,
		}),
		top_p: z.number().nullable().optional().openapi({
			description:
				"An alternative to sampling with temperature, called nucleus sampling.",
			example: 0.9,
		}),
		max_output_tokens: z.number().int().nullable().optional().openapi({
			description:
				"An upper bound for the number of tokens that can be generated.",
			example: 1000,
		}),
		max_tokens: z.number().int().nullable().optional().openapi({
			description: "Alias for max_output_tokens for compatibility.",
		}),
		tools: z.array(z.any()).optional().openapi({
			description:
				"An array of tools the model may call while generating a response.",
		}),
		tool_choice: toolChoiceSchema.optional().openapi({
			description:
				"How the model should select which tool (or tools) to use when generating a response.",
		}),
		parallel_tool_calls: z.boolean().optional().openapi({
			description: "Whether to allow the model to run tool calls in parallel.",
		}),
		reasoning: reasoningConfigSchema,
		text: textConfigSchema,
		stream: z.boolean().optional().default(false).openapi({
			description: "Whether to stream the response.",
		}),
		metadata: z.record(z.any()).nullable().optional().openapi({
			description:
				"Set of 16 key-value pairs that can be attached to an object.",
		}),
		previous_response_id: z.string().nullable().optional().openapi({
			description:
				"The unique ID of the previous response for multi-turn conversations.",
		}),
		user: z.string().optional().openapi({
			description: "A unique identifier representing your end-user.",
		}),
		// Include any other fields for forwards compatibility
	})
	.catchall(z.any());

type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

async function forwardDirectResponsesRequest(
	c: Context,
	request: ResponsesRequest,
	rawBody: unknown,
): Promise<Response | null> {
	const requestContext = await resolveRequestContext(c, request.model);
	const {
		apiKey,
		project,
		organization,
		requestedModel,
		requestedProvider,
		customProviderName,
		modelInfo,
	} = requestContext;

	if (requestedModel === "auto" || requestedProvider === "custom") {
		return null;
	}

	const artifacts = createDirectResponsesArtifacts(request);

	validateModelCapabilities(modelInfo, requestedModel, requestedProvider, {
		response_format: artifacts.responseFormat,
		reasoning_effort: artifacts.reasoningEffort,
		reasoning_max_tokens: artifacts.reasoningMaxTokens,
		tools: artifacts.chatTools,
		tool_choice: artifacts.chatRequest.tool_choice,
		webSearchTool: artifacts.webSearchTool,
	});

	const iamValidation = await validateModelAccess(
		apiKey.id,
		modelInfo.id,
		requestedProvider,
		modelInfo,
	);
	if (!iamValidation.allowed) {
		if (!iamValidation.reason) {
			throw new HTTPException(403, {
				message: "Access denied for requested model",
			});
		}
		throwIamException(iamValidation.reason);
	}

	const allowedProviders = iamValidation.allowedProviders
		? modelInfo.providers.filter((provider) =>
				iamValidation.allowedProviders?.includes(provider.providerId),
			)
		: modelInfo.providers;

	const responseCapableProviders = allowedProviders.filter(
		(provider) =>
			(provider as ProviderModelMapping).supportsResponsesApi === true,
	);
	if (responseCapableProviders.length === 0) {
		return null;
	}

	const candidateProviders =
		requestedProvider && requestedProvider !== "llmgateway"
			? responseCapableProviders.filter(
					(provider) => provider.providerId === requestedProvider,
				)
			: responseCapableProviders;

	if (candidateProviders.length === 0) {
		return null;
	}

	const noFallback =
		c.req.raw.headers.get("x-no-fallback") === "true" ||
		c.req.raw.headers.get("X-No-Fallback") === "true";
	const providerScores = candidateProviders.map((provider, index) => ({
		providerId: provider.providerId,
		score: index,
	}));
	const failedProviderIds = new Set<string>();
	const routingAttempts: RoutingAttempt[] = [];
	const finalLogId = shortid();

	const resolveResponsesProviderContext = async (
		providerMapping: ProviderModelMapping,
	) => {
		const context = await resolveProviderContext(
			{
				providerId: providerMapping.providerId,
				modelName: providerMapping.modelName,
			},
			{
				mode: project.mode,
				organizationId: project.organizationId,
			},
			{
				id: organization.id,
				credits: organization.credits,
				devPlan: organization.devPlan,
				devPlanCreditsLimit: organization.devPlanCreditsLimit,
				devPlanCreditsUsed: organization.devPlanCreditsUsed,
				devPlanExpiresAt: organization.devPlanExpiresAt,
			},
			modelInfo,
			{
				temperature:
					typeof request.temperature === "number"
						? request.temperature
						: undefined,
				max_tokens:
					typeof (request.max_output_tokens ?? request.max_tokens) === "number"
						? (request.max_output_tokens ?? request.max_tokens ?? undefined)
						: undefined,
				top_p: typeof request.top_p === "number" ? request.top_p : undefined,
				frequency_penalty: undefined,
				presence_penalty: undefined,
			},
			{
				stream: request.stream ?? false,
				effectiveStream: request.stream ?? false,
				messages: artifacts.messages,
				response_format: artifacts.responseFormat,
				tools: artifacts.chatTools,
				tool_choice: artifacts.chatRequest.tool_choice as
					| "auto"
					| "none"
					| "required"
					| { type: "function"; function: { name: string } }
					| undefined,
				reasoning_effort: artifacts.reasoningEffort,
				reasoning_max_tokens: artifacts.reasoningMaxTokens,
				effort: undefined,
				webSearchTool: artifacts.webSearchTool,
				image_config: undefined,
				sensitive_word_check: undefined,
				maxImageSizeMB: organization.plan === "pro" ? 100 : 10,
				userPlan: organization.plan,
				hasExistingToolCalls: artifacts.messages.some(
					(message) => message.role === "tool" || !!message.tool_calls,
				),
				customProviderName,
				webSearchEnabled: !!artifacts.webSearchTool,
			},
		);

		return context.useResponsesApi ? context : null;
	};

	let resolvedContext: Awaited<
		ReturnType<typeof resolveProviderContext>
	> | null = null;
	let activeProviderMapping: ProviderModelMapping | null = null;

	for (const providerMapping of candidateProviders) {
		try {
			resolvedContext = await resolveResponsesProviderContext(providerMapping);
		} catch {
			continue;
		}

		if (resolvedContext) {
			activeProviderMapping = providerMapping;
			break;
		}
	}

	if (!resolvedContext || !activeProviderMapping) {
		return null;
	}

	let response: Response | null = null;
	let lastUpstreamRequestBody: Record<string, unknown> | null = null;
	let duration = 0;

	for (let retryAttempt = 0; retryAttempt <= MAX_RETRIES; retryAttempt++) {
		if (!resolvedContext || !activeProviderMapping) {
			break;
		}

		if (retryAttempt > 0) {
			const nextProvider = selectNextProvider(
				providerScores,
				failedProviderIds,
				candidateProviders,
			);
			if (!nextProvider) {
				break;
			}

			try {
				const nextContext = await resolveResponsesProviderContext(
					nextProvider as ProviderModelMapping,
				);
				if (!nextContext) {
					failedProviderIds.add(nextProvider.providerId);
					retryAttempt--;
					continue;
				}

				resolvedContext = nextContext;
				activeProviderMapping = nextProvider as ProviderModelMapping;
			} catch {
				failedProviderIds.add(nextProvider.providerId);
				retryAttempt--;
				continue;
			}
		}

		const upstreamRequestBody = {
			...(resolvedContext.requestBody as unknown as Record<string, unknown>),
			...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
			...(request.previous_response_id
				? { previous_response_id: request.previous_response_id }
				: {}),
			...(request.parallel_tool_calls !== undefined
				? { parallel_tool_calls: request.parallel_tool_calls }
				: {}),
		};
		const attemptResolvedContext = resolvedContext;
		lastUpstreamRequestBody = upstreamRequestBody;

		const attemptResult = await executeNonStreamingAttempt({
			requestSignal: c.req.raw.signal,
			resolvedContext: attemptResolvedContext,
			upstreamRequestBody,
			createBaseLogEntry: (rawResponse, upstreamResponse) =>
				createDirectResponsesBaseLogEntry(
					requestContext,
					request,
					artifacts,
					attemptResolvedContext,
					rawBody,
					rawResponse,
					upstreamRequestBody,
					upstreamResponse,
				),
			messages: artifacts.messages,
			inputImageCount: artifacts.inputImageCount,
			webSearchEnabled: !!artifacts.webSearchTool,
			organizationId: project.organizationId,
			retentionLevel: organization.retentionLevel,
			getRetryMetadata: ({ statusCode }) => {
				const retried = shouldRetryRequest({
					requestedProvider,
					noFallback,
					statusCode,
					retryCount: retryAttempt,
					remainingProviders:
						candidateProviders.length - failedProviderIds.size - 1,
					usedProvider: attemptResolvedContext.usedProvider,
				});

				return {
					retried,
					retriedByLogId: retried ? finalLogId : null,
				};
			},
		});
		duration = attemptResult.duration;

		if (attemptResult.type === "fetch_error") {
			const willRetryFetch = shouldRetryRequest({
				requestedProvider,
				noFallback,
				statusCode: 0,
				retryCount: retryAttempt,
				remainingProviders:
					candidateProviders.length - failedProviderIds.size - 1,
				usedProvider: resolvedContext.usedProvider,
			});
			if (willRetryFetch) {
				routingAttempts.push({
					provider: resolvedContext.usedProvider,
					model: resolvedContext.usedModel,
					status_code: 0,
					error_type: getErrorType(0),
					succeeded: false,
				});
				failedProviderIds.add(resolvedContext.usedProvider);
				continue;
			}

			return c.json(
				{
					error: {
						message: attemptResult.isTimeout
							? `Upstream provider timeout: ${attemptResult.message}`
							: `Failed to connect to provider: ${attemptResult.message}`,
						type: attemptResult.isTimeout
							? "upstream_timeout"
							: "upstream_error",
						param: null,
						code: attemptResult.isTimeout ? "timeout" : "fetch_failed",
					},
				},
				attemptResult.isTimeout ? 504 : 502,
			);
		}

		if (attemptResult.type === "canceled") {
			return c.json(
				{
					error: {
						message: "Request canceled by client",
						type: "canceled",
						param: null,
						code: "request_canceled",
					},
				},
				400,
			);
		}

		if (attemptResult.type === "http_error") {
			const willRetryHttp = shouldRetryRequest({
				requestedProvider,
				noFallback,
				statusCode: attemptResult.status,
				retryCount: retryAttempt,
				remainingProviders:
					candidateProviders.length - failedProviderIds.size - 1,
				usedProvider: resolvedContext.usedProvider,
			});
			if (willRetryHttp) {
				routingAttempts.push({
					provider: resolvedContext.usedProvider,
					model: resolvedContext.usedModel,
					status_code: attemptResult.status,
					error_type: getErrorType(attemptResult.status),
					succeeded: false,
				});
				failedProviderIds.add(resolvedContext.usedProvider);
				continue;
			}

			if (attemptResult.finishReason === "content_filter") {
				return c.json({
					id: `resp-${Date.now()}`,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					model: request.model,
					status: "completed",
					output: [],
					output_text: "",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
					},
					metadata: {
						requested_model: request.model,
						requested_provider: requestContext.requestedProvider ?? null,
						used_model: modelInfo.id,
						used_provider: resolvedContext.usedProvider,
						underlying_used_model: resolvedContext.usedModel,
						...(routingAttempts.length > 0 ? { routing: routingAttempts } : {}),
					},
				});
			}

			if (attemptResult.finishReason === "client_error") {
				try {
					return c.json(
						JSON.parse(attemptResult.errorText),
						attemptResult.status as 400,
					);
				} catch {
					// Fall through to wrapped error response.
				}
			}

			return c.json(
				{
					error: {
						message:
							attemptResult.errorText ??
							`Error from provider: ${attemptResult.status} ${attemptResult.statusText}`,
						type: attemptResult.finishReason,
						param: null,
						code: attemptResult.finishReason,
					},
				},
				attemptResult.status >= 500 ? 502 : (attemptResult.status as 400),
			);
		}

		response = attemptResult.response;
		break;
	}

	if (!response || !resolvedContext || !lastUpstreamRequestBody) {
		return c.json(
			{
				error: {
					message: "All provider attempts failed",
					type: "upstream_error",
					param: null,
					code: "all_providers_failed",
				},
			},
			502,
		);
	}

	if (routingAttempts.length > 0) {
		routingAttempts.push({
			provider: resolvedContext.usedProvider,
			model: resolvedContext.usedModel,
			status_code: response.status,
			error_type: "none",
			succeeded: true,
		});
	}

	if (request.stream) {
		if (resolvedContext.envVarName !== undefined) {
			reportKeySuccess(resolvedContext.envVarName, resolvedContext.configIndex);
		}

		const headers = new Headers();
		headers.set(
			"Content-Type",
			response.headers.get("Content-Type") ?? "text/event-stream",
		);
		headers.set("Cache-Control", "no-cache");
		headers.set("Connection", "keep-alive");
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	}

	let processedResponse: Awaited<
		ReturnType<typeof processNonStreamingProviderResponse>
	>;
	try {
		processedResponse = await processNonStreamingProviderResponse({
			response,
			usedProvider: resolvedContext.usedProvider,
			usedModel: resolvedContext.usedModel,
			messages: artifacts.messages,
			responseFormat: artifacts.responseFormat,
			responseHealingEnabled: false,
			inputImageCount: artifacts.inputImageCount,
			organizationId: project.organizationId,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.message
				: "Failed to parse upstream response";
		const baseLogEntry = createDirectResponsesBaseLogEntry(
			requestContext,
			request,
			artifacts,
			resolvedContext,
			rawBody,
			null,
			lastUpstreamRequestBody,
			null,
		);

		await insertLog({
			...baseLogEntry,
			id: routingAttempts.length > 0 ? finalLogId : undefined,
			duration,
			timeToFirstToken: null,
			timeToFirstReasoningToken: null,
			responseSize: 0,
			content: null,
			reasoningContent: null,
			finishReason: "upstream_error",
			promptTokens: null,
			completionTokens: null,
			totalTokens: null,
			reasoningTokens: null,
			cachedTokens: null,
			hasError: true,
			streamed: false,
			canceled: false,
			errorDetails: {
				statusCode: response.status,
				statusText: error instanceof Error ? error.name : "Error",
				responseText: errorMessage,
				cause: extractErrorCause(error),
			},
			inputCost: null,
			outputCost: null,
			cachedInputCost: null,
			requestCost: null,
			webSearchCost: null,
			imageInputTokens: null,
			imageOutputTokens: null,
			imageInputCost: null,
			imageOutputCost: null,
			cost: null,
			estimatedCost: false,
			discount: null,
			pricingTier: null,
			dataStorageCost: "0",
			cached: false,
			toolResults: null,
		});

		return c.json(
			{
				error: {
					message: errorMessage,
					type: "upstream_error",
					param: null,
					code: "parse_failed",
				},
			},
			502,
		);
	}

	const { json } = processedResponse;

	if (process.env.NODE_ENV !== "production") {
		logger.debug("API response", { response: json });
	}

	const normalized = normalizeResponsesApiResponse(
		json,
		request,
		modelInfo.id,
		resolvedContext.usedProvider,
		resolvedContext.usedModel,
		routingAttempts.length > 0
			? routingAttempts.map((attempt) => ({ ...attempt }))
			: undefined,
	);
	const baseLogEntry = createDirectResponsesBaseLogEntry(
		requestContext,
		request,
		artifacts,
		resolvedContext,
		rawBody,
		normalized,
		lastUpstreamRequestBody,
		json,
	);
	const loggedPromptTokens =
		processedResponse.costs.promptTokens ??
		processedResponse.calculatedPromptTokens;
	const loggedCompletionTokens =
		processedResponse.costs.completionTokens ??
		processedResponse.calculatedCompletionTokens;
	const loggedTotalTokens =
		processedResponse.totalTokens ??
		(loggedPromptTokens ?? 0) +
			(loggedCompletionTokens ?? 0) +
			(processedResponse.reasoningTokens ?? 0);

	await insertLog({
		...baseLogEntry,
		id: routingAttempts.length > 0 ? finalLogId : undefined,
		duration,
		timeToFirstToken: null,
		timeToFirstReasoningToken: null,
		responseSize: processedResponse.responseSize,
		content: processedResponse.content,
		reasoningContent: processedResponse.reasoningContent,
		finishReason: processedResponse.finishReason,
		promptTokens: loggedPromptTokens?.toString() ?? null,
		completionTokens: loggedCompletionTokens?.toString() ?? null,
		totalTokens: loggedTotalTokens?.toString() ?? null,
		reasoningTokens: processedResponse.reasoningTokens?.toString() ?? null,
		cachedTokens: processedResponse.cachedTokens?.toString() ?? null,
		hasError: false,
		streamed: false,
		canceled: false,
		errorDetails: null,
		inputCost: processedResponse.costs.inputCost,
		outputCost: processedResponse.costs.outputCost,
		cachedInputCost: processedResponse.costs.cachedInputCost,
		requestCost: processedResponse.costs.requestCost,
		webSearchCost: processedResponse.costs.webSearchCost,
		imageInputTokens:
			processedResponse.costs.imageInputTokens?.toString() ?? null,
		imageOutputTokens:
			processedResponse.costs.imageOutputTokens?.toString() ?? null,
		imageInputCost: processedResponse.costs.imageInputCost ?? null,
		imageOutputCost: processedResponse.costs.imageOutputCost ?? null,
		cost: processedResponse.costs.totalCost,
		estimatedCost: processedResponse.costs.estimatedCost,
		discount: processedResponse.costs.discount ?? null,
		pricingTier: processedResponse.costs.pricingTier ?? null,
		dataStorageCost: calculateDataStorageCost(
			loggedPromptTokens,
			processedResponse.cachedTokens,
			loggedCompletionTokens,
			processedResponse.reasoningTokens,
			organization.retentionLevel,
		),
		cached: false,
		tools: artifacts.chatTools as any,
		toolResults: processedResponse.toolResults ?? null,
		toolChoice: artifacts.chatRequest.tool_choice as any,
	});

	if (resolvedContext.envVarName !== undefined) {
		reportKeySuccess(resolvedContext.envVarName, resolvedContext.configIndex);
	}

	return c.json(normalized);
}

// ============================================
// Forward to Chat Completions
// ============================================

async function forwardToChatCompletions(
	c: Context,
	chatRequest: Record<string, unknown>,
): Promise<any> {
	const response = await app.request("/v1/chat/completions", {
		method: "POST",
		headers: forwardRequestHeaders({
			authorization: c.req.header("Authorization") ?? "",
			xApiKey: c.req.header("x-api-key") ?? "",
			userAgent: c.req.header("User-Agent") ?? "",
			requestId: c.req.header("x-request-id") ?? "",
			source: c.req.header("x-source") ?? "",
			debug: c.req.header("x-debug") ?? "",
			httpReferer: c.req.header("HTTP-Referer") ?? "",
		}),
		body: JSON.stringify(chatRequest),
	});

	if (!response.ok) {
		logger.warn("Responses API - chat completions request failed", {
			status: response.status,
			statusText: response.statusText,
		});
		const errorData = await response.text();
		let errorMessage = `Responses request failed with status ${response.status}`;
		try {
			const parsed = JSON.parse(errorData);
			errorMessage = parsed?.error?.message ?? parsed?.message ?? errorMessage;
		} catch {
			// use default message
		}

		throw new HTTPException(response.status as any, {
			message: errorMessage,
		});
	}

	try {
		const responseText = await response.text();
		return JSON.parse(responseText);
	} catch (error) {
		logger.error("Responses API - failed to parse chat completions response", {
			err: error instanceof Error ? error : new Error(String(error)),
		});
		throw new HTTPException(500, {
			message: "Failed to parse responses response",
		});
	}
}

// ============================================
// Route Definitions
// ============================================

// ============================================
// Main Router
// ============================================

export const responses = new OpenAPIHono<ServerTypes>();

// Use a simple POST handler first with manual parsing to avoid zod issues
responses.post("/", async (c) => {
	// Manual request parsing with better error handling
	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		throw new HTTPException(400, {
			message: "Invalid JSON in request body",
		});
	}

	// Validate against schema with safeParse
	const validationResult = responsesRequestSchema.safeParse(rawBody);
	if (!validationResult.success) {
		// Even if validation fails, try to proceed with rawBody for compatibility
		logger.debug(
			"Responses API - validation failed, continuing with raw body",
			{
				errors: validationResult.error.issues.map((i) => ({
					path: i.path.join("."),
					message: i.message,
				})),
			},
		);
	}

	// Use validated data if available, otherwise raw body
	const request = validationResult.success
		? validationResult.data
		: (rawBody as ResponsesRequest);

	const directResponse = await forwardDirectResponsesRequest(
		c,
		request,
		rawBody,
	);
	if (directResponse) {
		return directResponse;
	}

	// Convert Responses API request to chat completions request
	const chatRequest = convertToChatCompletionsRequest(request);

	logger.debug("Responses API - forwarding to chat completions", {
		model: request.model,
		inputPreview:
			typeof request.input === "string"
				? request.input.slice(0, 200)
				: Array.isArray(request.input)
					? `${request.input.length} input items`
					: "no input",
		stream: request.stream,
	});

	const chatResponse = await forwardToChatCompletions(c, chatRequest);

	// Convert chat completions response to Responses API format
	const responsesResponse = convertToResponsesResponse(
		chatResponse,
		request.model,
	);

	logger.debug("response output", { chatResponse, responsesResponse });

	logger.debug("Responses API - returning response", {
		responseId: responsesResponse.id,
		model: request.model,
		outputLength: responsesResponse.output_text.length,
	});

	return c.json(responsesResponse);
});

// GET /:response_id endpoint - not implemented, returns 404
const errorMessage =
	"Retrieving responses by ID is not currently supported. Please use the create endpoint directly.";

responses.get("/:response_id", (c) => {
	return c.text(errorMessage, 404);
});
