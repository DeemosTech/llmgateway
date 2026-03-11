import { OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { createLogEntry } from "@/chat/tools/create-log-entry.js";
import { createProxyAgent } from "@/chat/tools/create-proxy-agent.js";
import { estimateTokens } from "@/chat/tools/estimate-tokens.js";
import { getProviderEnv } from "@/chat/tools/get-provider-env.js";
import {
	MAX_RETRIES,
	selectNextProvider,
	shouldRetryRequest,
} from "@/chat/tools/retry-with-fallback.js";
import { resolveRequestContext } from "@/common/resolve-request-context.js";
import { reportKeyError, reportKeySuccess } from "@/lib/api-key-health.js";
import { findProviderKey } from "@/lib/cached-queries.js";
import { throwIamException, validateModelAccess } from "@/lib/iam.js";
import { calculateDataStorageCost, insertLog } from "@/lib/logs.js";

import {
	getProviderHeaders,
	getVideoProviderEndpoint,
	prepareVideoRequestBody,
} from "@llmgateway/actions";
import { redisClient } from "@llmgateway/cache";
import {
	getEffectiveDiscount,
	shortid,
	type InferSelectModel,
	UnifiedFinishReason,
} from "@llmgateway/db";
import { logger } from "@llmgateway/logger";

import type { ResolvedRequestContext } from "@/common/resolve-request-context.js";
import type { ServerTypes } from "@/vars.js";
import type { tables } from "@llmgateway/db";
import type { Provider, ProviderModelMapping } from "@llmgateway/models";
import type { Context } from "hono";

const VIDEO_JOB_TTL_SECONDS = 60 * 60 * 24;

const videoSizeSchema = z.enum([
	"720x1280",
	"1280x720",
	"1024x1792",
	"1792x1024",
]);

const videoGenerationRequestSchema = z.object({
	model: z.string().optional().default("sora-2").openapi({
		example: "sora-2",
	}),
	prompt: z.string().min(1).openapi({
		example: "A serene mountain landscape with flowing waterfalls at sunset",
	}),
	input_reference: z.string().optional().openapi({
		description: "Optional reference asset that guides generation.",
	}),
	seconds: z
		.union([z.literal(4), z.literal(8), z.literal(12)])
		.optional()
		.default(4)
		.openapi({
			description: "Clip duration in seconds.",
			example: 4,
		}),
	size: videoSizeSchema.optional().default("720x1280").openapi({
		description: "Output video size formatted as width x height.",
		example: "720x1280",
	}),
});

type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>;

const videoGenerationResponseSchema = z.object({
	id: z.string(),
	object: z.literal("video"),
	completed_at: z.number().nullable(),
	created_at: z.number(),
	error: z
		.object({
			code: z.string().optional(),
			message: z.string().optional(),
		})
		.nullable(),
	expires_at: z.number().nullable(),
	model: z.string(),
	progress: z.number(),
	prompt: z.string().nullable(),
	remixed_from_video_id: z.string().nullable(),
	seconds: z.number(),
	size: z.string(),
	status: z.enum(["queued", "in_progress", "completed", "failed"]),
});

type ProviderKey = InferSelectModel<typeof tables.providerKey>;

type VideoJobStatus = "queued" | "in_progress" | "completed" | "failed";

interface VideoProviderContext {
	usedProvider: Provider;
	usedModel: string;
	usedModelMapping: string;
	providerKey: ProviderKey | undefined;
	configIndex: number;
	envVarName: string | undefined;
	url: string;
	headers: Record<string, string>;
	requestBody: BodyInit | Record<string, unknown>;
	useProxy: boolean;
}

interface StoredVideoJob {
	id: string;
	request: VideoGenerationRequest;
	rawRequest: unknown;
	projectId: string;
	organizationId: string;
	projectMode: string;
	usedProvider: Provider;
	usedModel: string;
	usedModelMapping: string;
	envVarName?: string;
	configIndex: number;
	upstreamId: string;
	createdAt: number;
	completedAt: number | null;
	expiresAt: number | null;
	status: VideoJobStatus;
	progress: number;
	error: {
		code?: string;
		message?: string;
	} | null;
	logged: boolean;
	contentUrl?: string;
}

interface VideoStartResult {
	type: "success" | "fetch_error" | "http_error" | "canceled";
	duration: number;
	statusCode?: number;
	statusText?: string;
	errorText?: string;
	rawResponse?: unknown;
	upstreamId?: string;
	status?: VideoJobStatus;
	progress?: number;
	createdAt?: number;
	completedAt?: number | null;
	error?: {
		code?: string;
		message?: string;
	} | null;
	contentUrl?: string;
}

interface VideoContentHint {
	type: "url" | "b64_json";
	value: string;
	mimeType?: string;
}

interface VideoStatusRefreshResult {
	job: StoredVideoJob;
	upstreamResponse: unknown;
	contentHint: VideoContentHint | null;
}

function videoJobKey(id: string): string {
	return `video_job:${id}`;
}

function parseVideoSize(size: VideoGenerationRequest["size"]): {
	aspectRatio: "16:9" | "9:16";
	resolution: "720p" | "1080p";
} {
	switch (size) {
		case "1280x720":
			return { aspectRatio: "16:9", resolution: "720p" };
		case "1792x1024":
			return { aspectRatio: "16:9", resolution: "1080p" };
		case "1024x1792":
			return { aspectRatio: "9:16", resolution: "1080p" };
		case "720x1280":
		default:
			return { aspectRatio: "9:16", resolution: "720p" };
	}
}

function buildVideoJobResponse(
	job: StoredVideoJob,
): z.infer<typeof videoGenerationResponseSchema> {
	return {
		id: job.id,
		object: "video",
		completed_at: job.completedAt,
		created_at: job.createdAt,
		error: job.error,
		expires_at: job.expiresAt,
		model: job.usedModel,
		progress: job.progress,
		prompt: job.request.prompt,
		remixed_from_video_id: null,
		seconds: job.request.seconds,
		size: job.request.size,
		status: job.status,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeRequestBody(
	body: BodyInit | Record<string, unknown>,
): BodyInit | string {
	if (
		typeof body === "string" ||
		body instanceof FormData ||
		body instanceof URLSearchParams ||
		body instanceof Blob ||
		body instanceof ArrayBuffer ||
		ArrayBuffer.isView(body) ||
		body instanceof ReadableStream
	) {
		return body;
	}

	return JSON.stringify(body);
}

function buildErrorPayload(
	message: string,
	code: string,
	type = "invalid_request_error",
) {
	return {
		error: {
			message,
			type,
			param: null,
			code,
		},
	};
}

function parseOpenAIError(error: unknown): {
	code?: string;
	message?: string;
} | null {
	if (typeof error === "string") {
		return { message: error };
	}
	if (!isRecord(error)) {
		return null;
	}
	return {
		code: typeof error.code === "string" ? error.code : undefined,
		message: typeof error.message === "string" ? error.message : undefined,
	};
}

function extractGoogleContentHint(
	payload: Record<string, unknown>,
): VideoContentHint | null {
	const aiStudioSamples = (
		payload.response as
			| {
					generateVideoResponse?: {
						generatedSamples?: Array<{
							video?: {
								uri?: string;
								bytesBase64Encoded?: string;
								mimeType?: string;
							};
						}>;
					};
			  }
			| undefined
	)?.generateVideoResponse?.generatedSamples;
	const aiStudioVideo = aiStudioSamples?.[0]?.video;
	if (typeof aiStudioVideo?.bytesBase64Encoded === "string") {
		return {
			type: "b64_json",
			value: aiStudioVideo.bytesBase64Encoded,
			mimeType:
				typeof aiStudioVideo.mimeType === "string"
					? aiStudioVideo.mimeType
					: "video/mp4",
		};
	}
	if (typeof aiStudioVideo?.uri === "string") {
		return {
			type: "url",
			value: aiStudioVideo.uri,
			mimeType:
				typeof aiStudioVideo.mimeType === "string"
					? aiStudioVideo.mimeType
					: undefined,
		};
	}

	const vertexVideos = (
		payload.response as
			| {
					videos?: Array<{
						gcsUri?: string;
						uri?: string;
						bytesBase64Encoded?: string;
						mimeType?: string;
					}>;
			  }
			| undefined
	)?.videos;
	const vertexVideo = vertexVideos?.[0];
	if (typeof vertexVideo?.bytesBase64Encoded === "string") {
		return {
			type: "b64_json",
			value: vertexVideo.bytesBase64Encoded,
			mimeType:
				typeof vertexVideo.mimeType === "string"
					? vertexVideo.mimeType
					: "video/mp4",
		};
	}
	if (typeof vertexVideo?.uri === "string") {
		return {
			type: "url",
			value: vertexVideo.uri,
			mimeType:
				typeof vertexVideo.mimeType === "string"
					? vertexVideo.mimeType
					: undefined,
		};
	}
	if (typeof vertexVideo?.gcsUri === "string") {
		return {
			type: "url",
			value: vertexVideo.gcsUri,
			mimeType:
				typeof vertexVideo.mimeType === "string"
					? vertexVideo.mimeType
					: undefined,
		};
	}

	return null;
}

function buildGoogleOperationPollRequest(
	context: VideoProviderContext,
	operationName: string,
): { url: string; method: "GET" | "POST"; body?: string } {
	if (context.usedProvider === "google-ai-studio") {
		const pollUrl = new URL(context.url);
		pollUrl.pathname = `/v1beta/${operationName}`;
		return {
			url: pollUrl.toString(),
			method: "GET",
		};
	}

	return {
		url: context.url.replace(":predictLongRunning", ":fetchPredictOperation"),
		method: "POST",
		body: JSON.stringify({
			operationName,
		}),
	};
}

async function saveVideoJob(job: StoredVideoJob): Promise<void> {
	await redisClient.set(
		videoJobKey(job.id),
		JSON.stringify(job),
		"EX",
		VIDEO_JOB_TTL_SECONDS,
	);
}

async function loadVideoJob(id: string): Promise<StoredVideoJob | null> {
	const raw = await redisClient.get(videoJobKey(id));
	if (!raw) {
		return null;
	}

	try {
		return JSON.parse(raw) as StoredVideoJob;
	} catch {
		return null;
	}
}

async function resolveVideoProviderContext(args: {
	providerMapping: ProviderModelMapping;
	projectMode: string;
	organizationId: string;
	request: VideoGenerationRequest;
}): Promise<VideoProviderContext> {
	const { providerMapping, projectMode, organizationId, request } = args;
	const usedProvider = providerMapping.providerId as Provider;
	let providerKey: ProviderKey | undefined;
	let usedToken: string | undefined;
	let configIndex = 0;
	let envVarName: string | undefined;

	if (projectMode === "api-keys") {
		providerKey = await findProviderKey(organizationId, usedProvider);
		if (!providerKey) {
			throw new HTTPException(400, {
				message: `No API key set for provider: ${usedProvider}`,
			});
		}
		usedToken = providerKey.token;
	} else if (projectMode === "credits") {
		const envResult = getProviderEnv(usedProvider);
		usedToken = envResult.token;
		configIndex = envResult.configIndex;
		envVarName = envResult.envVarName;
	} else {
		providerKey = await findProviderKey(organizationId, usedProvider);
		if (providerKey) {
			usedToken = providerKey.token;
		} else {
			const envResult = getProviderEnv(usedProvider);
			usedToken = envResult.token;
			configIndex = envResult.configIndex;
			envVarName = envResult.envVarName;
		}
	}

	if (!usedToken) {
		throw new HTTPException(500, {
			message: `No credentials available for provider: ${usedProvider}`,
		});
	}

	const url = getVideoProviderEndpoint(
		usedProvider,
		providerKey?.baseUrl ?? undefined,
		providerMapping.modelName,
		usedToken,
		providerKey?.options ?? undefined,
		configIndex,
	);

	const parsedSize = parseVideoSize(request.size);
	const preparedRequest = prepareVideoRequestBody(
		usedProvider,
		providerMapping.modelName,
		request.prompt,
		{
			aspect_ratio: parsedSize.aspectRatio,
			duration: request.seconds,
			resolution: parsedSize.resolution,
			input_reference: request.input_reference,
		},
	);

	return {
		usedProvider,
		usedModel: providerMapping.modelName,
		usedModelMapping: providerMapping.modelName,
		providerKey,
		configIndex,
		envVarName,
		url,
		headers: {
			...getProviderHeaders(usedProvider, usedToken),
			...(preparedRequest.headers ?? {}),
		},
		requestBody: preparedRequest.body,
		useProxy: providerMapping.proxy ?? providerKey?.options?.proxy ?? false,
	};
}

async function startVideoGenerationAttempt(
	c: Context,
	context: VideoProviderContext,
): Promise<VideoStartResult> {
	const startedAt = Date.now();

	try {
		const dispatcher = createProxyAgent(
			context.url,
			context.useProxy,
			context.providerKey,
		);
		logger.debug("Starting video generation attempt", {
			url: context.url,
			useProxy: context.useProxy,
			body: context.requestBody,
			serializedBody: serializeRequestBody(context.requestBody),
		});
		const requestOptions: RequestInit & { dispatcher?: unknown } = {
			method: "POST",
			headers: context.headers,
			body: serializeRequestBody(context.requestBody),
			signal: c.req.raw.signal,
		};
		if (dispatcher) {
			requestOptions.dispatcher = dispatcher;
		}

		const response = await fetch(context.url, requestOptions);
		if (!response.ok) {
			return {
				type: "http_error",
				duration: Date.now() - startedAt,
				statusCode: response.status,
				statusText: response.statusText,
				errorText: await response.text(),
			};
		}

		const payload = (await response.json()) as unknown;
		if (!isRecord(payload)) {
			return {
				type: "http_error",
				duration: Date.now() - startedAt,
				statusCode: 502,
				statusText: "Invalid upstream response",
				errorText: "Video generation response was not a valid object",
			};
		}

		switch (context.usedProvider) {
			case "tuzi":
			case "openai": {
				const upstreamId = payload.id;
				if (typeof upstreamId !== "string" || !upstreamId) {
					return {
						type: "http_error",
						duration: Date.now() - startedAt,
						statusCode: 502,
						statusText: "Invalid upstream response",
						errorText: "OpenAI video generation did not return a video id",
						rawResponse: payload,
					};
				}

				const status =
					payload.status === "completed"
						? "completed"
						: payload.status === "failed"
							? "failed"
							: payload.status === "queued"
								? "queued"
								: "in_progress";

				return {
					type: "success",
					duration: Date.now() - startedAt,
					rawResponse: payload,
					upstreamId,
					status,
					progress:
						typeof payload.progress === "number"
							? payload.progress
							: status === "queued"
								? 0
								: status === "completed"
									? 100
									: 10,
					createdAt:
						typeof payload.created_at === "number"
							? payload.created_at
							: Math.floor(startedAt / 1000),
					completedAt:
						typeof payload.completed_at === "number"
							? payload.completed_at
							: status === "completed"
								? Math.floor(Date.now() / 1000)
								: null,
					error: parseOpenAIError(payload.error),
				};
			}
			case "google-ai-studio":
			case "google-vertex": {
				const operationName = payload.name;
				if (typeof operationName !== "string" || !operationName) {
					return {
						type: "http_error",
						duration: Date.now() - startedAt,
						statusCode: 502,
						statusText: "Invalid upstream response",
						errorText:
							"Video generation operation did not return an operation name",
						rawResponse: payload,
					};
				}

				const googleError = isRecord(payload.error)
					? {
							code:
								typeof payload.error.code === "string"
									? payload.error.code
									: undefined,
							message:
								typeof payload.error.message === "string"
									? payload.error.message
									: undefined,
						}
					: null;
				const completed = payload.done === true;
				const contentHint = completed
					? extractGoogleContentHint(payload)
					: null;

				return {
					type: "success",
					duration: Date.now() - startedAt,
					rawResponse: payload,
					upstreamId: operationName,
					status: googleError
						? "failed"
						: completed
							? "completed"
							: "in_progress",
					progress: googleError ? 0 : completed ? 100 : 10,
					createdAt: Math.floor(startedAt / 1000),
					completedAt: completed ? Math.floor(Date.now() / 1000) : null,
					error: googleError,
					contentUrl:
						contentHint?.type === "url" ? contentHint.value : undefined,
				};
			}
			default:
				return {
					type: "http_error",
					duration: Date.now() - startedAt,
					statusCode: 500,
					statusText: "Unsupported provider",
					errorText: `Unsupported provider: ${context.usedProvider}`,
				};
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return {
				type: "canceled",
				duration: Date.now() - startedAt,
			};
		}

		return {
			type: "fetch_error",
			duration: Date.now() - startedAt,
			errorText:
				error instanceof Error
					? error.message
					: "Failed to connect to provider",
		};
	}
}

function buildOpenAIVideoStatusUrl(
	context: VideoProviderContext,
	videoId: string,
): string {
	return `${context.url}/${videoId}`;
}

function buildOpenAIVideoContentUrl(
	context: VideoProviderContext,
	videoId: string,
): string {
	return `${context.url}/${videoId}/content`;
}

async function resolveJobProviderContext(
	requestContext: ResolvedRequestContext,
	job: StoredVideoJob,
): Promise<VideoProviderContext> {
	const providerMapping = requestContext.modelInfo.providers.find(
		(provider) =>
			provider.providerId === job.usedProvider &&
			provider.modelName === job.usedModel,
	) as ProviderModelMapping | undefined;

	if (!providerMapping) {
		throw new HTTPException(410, {
			message: `Provider ${job.usedProvider} for model ${job.usedModel} is no longer available`,
		});
	}

	return await resolveVideoProviderContext({
		providerMapping,
		projectMode: job.projectMode,
		organizationId: job.organizationId,
		request: job.request,
	});
}

async function refreshVideoJobStatus(
	c: Context,
	requestContext: ResolvedRequestContext,
	job: StoredVideoJob,
): Promise<VideoStatusRefreshResult> {
	const context = await resolveJobProviderContext(requestContext, job);
	const dispatcher = createProxyAgent(
		context.url,
		context.useProxy,
		context.providerKey,
	);

	switch (job.usedProvider) {
		case "tuzi":
		case "openai": {
			const pollOptions: RequestInit & { dispatcher?: unknown } = {
				method: "GET",
				headers: context.headers,
				signal: c.req.raw.signal,
			};
			if (dispatcher) {
				pollOptions.dispatcher = dispatcher;
			}

			const response = await fetch(
				buildOpenAIVideoStatusUrl(context, job.upstreamId),
				pollOptions,
			);
			if (!response.ok) {
				throw new HTTPException(response.status === 400 ? 400 : 500, {
					message: await response.text(),
				});
			}

			const payload = (await response.json()) as unknown;
			if (process.env.NODE_ENV !== "production") {
				logger.debug("Polled OpenAI video status", {
					url: context.url,
					request: pollOptions,
					response: payload,
				});
			}
			if (!isRecord(payload)) {
				throw new HTTPException(502, {
					message: "OpenAI video status response was not a valid object",
				});
			}

			const status =
				payload.status === "completed"
					? "completed"
					: payload.status === "failed"
						? "failed"
						: payload.status === "queued"
							? "queued"
							: "in_progress";

			const updatedJob: StoredVideoJob = {
				...job,
				status,
				progress:
					typeof payload.progress === "number"
						? payload.progress
						: status === "completed"
							? 100
							: status === "failed"
								? 0
								: 50,
				createdAt:
					typeof payload.created_at === "number"
						? payload.created_at
						: job.createdAt,
				completedAt:
					typeof payload.completed_at === "number"
						? payload.completed_at
						: status === "completed"
							? (job.completedAt ?? Math.floor(Date.now() / 1000))
							: null,
				error: parseOpenAIError(payload.error),
			};

			await saveVideoJob(updatedJob);
			return {
				job: updatedJob,
				upstreamResponse: payload,
				contentHint: null,
			};
		}
		case "google-vertex":
		case "google-ai-studio": {
			const pollRequest = buildGoogleOperationPollRequest(
				context,
				job.upstreamId,
			);
			const pollOptions: RequestInit & { dispatcher?: unknown } = {
				method: pollRequest.method,
				headers: context.headers,
				signal: c.req.raw.signal,
			};
			if (pollRequest.body) {
				pollOptions.body = pollRequest.body;
			}
			if (dispatcher) {
				pollOptions.dispatcher = dispatcher;
			}

			const response = await fetch(pollRequest.url, pollOptions);
			if (!response.ok) {
				throw new HTTPException(response.status === 400 ? 400 : 500, {
					message: await response.text(),
				});
			}

			const payload = (await response.json()) as unknown;
			if (!isRecord(payload)) {
				throw new HTTPException(502, {
					message: "Google video status response was not a valid object",
				});
			}

			const googleError = isRecord(payload.error)
				? {
						code:
							typeof payload.error.code === "string"
								? payload.error.code
								: undefined,
						message:
							typeof payload.error.message === "string"
								? payload.error.message
								: undefined,
					}
				: null;
			const completed = payload.done === true;
			const contentHint = completed ? extractGoogleContentHint(payload) : null;

			const updatedJob: StoredVideoJob = {
				...job,
				status: googleError
					? "failed"
					: completed
						? "completed"
						: "in_progress",
				progress: googleError ? 0 : completed ? 100 : 50,
				completedAt:
					completed || googleError ? Math.floor(Date.now() / 1000) : null,
				error: googleError,
				contentUrl:
					contentHint?.type === "url" ? contentHint.value : job.contentUrl,
			};

			await saveVideoJob(updatedJob);
			return {
				job: updatedJob,
				upstreamResponse: payload,
				contentHint,
			};
		}
		default:
			throw new HTTPException(500, {
				message: `Unsupported provider: ${job.usedProvider}`,
			});
	}
}

function buildVideoBaseLogEntry(args: {
	requestContext: ResolvedRequestContext;
	request: VideoGenerationRequest;
	context: VideoProviderContext;
	rawBody: unknown;
	rawResponse: unknown;
	upstreamResponse: unknown;
}) {
	const {
		requestContext,
		request,
		context,
		rawBody,
		rawResponse,
		upstreamResponse,
	} = args;
	return createLogEntry(
		requestContext.requestId,
		requestContext.project,
		requestContext.apiKey,
		context.providerKey?.id,
		context.usedModel,
		context.usedModelMapping,
		context.usedProvider,
		requestContext.requestedModel,
		requestContext.requestedProvider,
		[
			{
				role: "user",
				content: request.prompt,
			},
		],
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		requestContext.source,
		requestContext.customHeaders,
		requestContext.debugMode,
		requestContext.userAgent,
		undefined,
		undefined,
		rawBody,
		rawResponse,
		context.requestBody,
		upstreamResponse,
	);
}

async function insertVideoLog(args: {
	requestContext: ResolvedRequestContext;
	request: VideoGenerationRequest;
	context: VideoProviderContext;
	rawBody: unknown;
	rawResponse: unknown;
	upstreamResponse: unknown;
	duration: number;
	hasError: boolean;
	finishReason: string;
	errorDetails: {
		statusCode: number;
		statusText: string;
		responseText: string;
	} | null;
}) {
	const {
		requestContext,
		request,
		context,
		rawBody,
		rawResponse,
		upstreamResponse,
		duration,
		hasError,
		finishReason,
		errorDetails,
	} = args;
	const providerMapping = requestContext.modelInfo.providers.find(
		(provider) =>
			provider.providerId === context.usedProvider &&
			provider.modelName === context.usedModel,
	) as ProviderModelMapping | undefined;
	const rate = providerMapping?.videoPricePerSecond ?? 0;
	const resolvedRate =
		context.usedProvider === "openai" &&
		context.usedModel === "sora-2-pro" &&
		(request.size === "1792x1024" || request.size === "1024x1792")
			? 0.5
			: rate;
	const discountResult = await getEffectiveDiscount(
		requestContext.project.organizationId,
		context.usedProvider,
		requestContext.modelInfo.id,
		providerMapping?.discount ?? 0,
		providerMapping?.modelName,
	);
	const requestCost =
		resolvedRate * request.seconds * (1 - discountResult.discount);
	const estimatedTokens = estimateTokens(
		context.usedProvider,
		[
			{
				role: "user",
				content: request.prompt,
			},
		],
		null,
		null,
		0,
	);
	const promptTokens = estimatedTokens.calculatedPromptTokens ?? 0;
	const baseLogEntry = buildVideoBaseLogEntry({
		requestContext,
		request,
		context,
		rawBody,
		rawResponse,
		upstreamResponse,
	});

	await insertLog({
		...baseLogEntry,
		duration,
		timeToFirstToken: null,
		timeToFirstReasoningToken: null,
		responseSize: rawResponse ? JSON.stringify(rawResponse).length : 0,
		content: rawResponse ? JSON.stringify(rawResponse) : null,
		reasoningContent: null,
		finishReason,
		unifiedFinishReason:
			finishReason === "completed"
				? UnifiedFinishReason.COMPLETED
				: finishReason === "canceled"
					? UnifiedFinishReason.CANCELED
					: UnifiedFinishReason.UPSTREAM_ERROR,
		promptTokens: promptTokens.toString(),
		completionTokens: "0",
		totalTokens: promptTokens.toString(),
		reasoningTokens: null,
		cachedTokens: null,
		hasError,
		streamed: false,
		canceled: finishReason === "canceled",
		errorDetails,
		inputCost: 0,
		outputCost: 0,
		cachedInputCost: 0,
		requestCost,
		webSearchCost: 0,
		imageInputTokens: null,
		imageOutputTokens: null,
		imageInputCost: null,
		imageOutputCost: null,
		cost: requestCost,
		estimatedCost: false,
		discount: discountResult.discount !== 0 ? discountResult.discount : null,
		pricingTier: null,
		dataStorageCost: calculateDataStorageCost(
			promptTokens,
			null,
			0,
			null,
			requestContext.organization.retentionLevel,
		),
		cached: false,
		toolResults: null,
	});
}

async function maybeFinalizeVideoJob(args: {
	requestContext: ResolvedRequestContext;
	job: StoredVideoJob;
	rawResponse: unknown;
	upstreamResponse: unknown;
}): Promise<StoredVideoJob> {
	const { requestContext, job, rawResponse, upstreamResponse } = args;
	if (job.logged || (job.status !== "completed" && job.status !== "failed")) {
		return job;
	}

	const context = await resolveJobProviderContext(requestContext, job);
	await insertVideoLog({
		requestContext,
		request: job.request,
		context,
		rawBody: job.rawRequest,
		rawResponse,
		upstreamResponse,
		duration: 0,
		hasError: job.status === "failed",
		finishReason: job.status === "completed" ? "completed" : "upstream_error",
		errorDetails:
			job.status === "failed"
				? {
						statusCode: 500,
						statusText: "Upstream error",
						responseText: job.error?.message ?? "Video generation failed",
					}
				: null,
	});

	if (context.envVarName !== undefined) {
		if (job.status === "completed") {
			reportKeySuccess(context.envVarName, context.configIndex);
		} else {
			reportKeyError(
				context.envVarName,
				context.configIndex,
				500,
				job.error?.message,
			);
		}
	}

	const updatedJob: StoredVideoJob = {
		...job,
		logged: true,
	};
	await saveVideoJob(updatedJob);
	return updatedJob;
}

async function authorizeVideoJobAccess(
	c: Context,
	id: string,
): Promise<{
	requestContext: ResolvedRequestContext;
	job: StoredVideoJob;
}> {
	const job = await loadVideoJob(id);
	if (!job) {
		throw new HTTPException(404, {
			message: "Video not found",
		});
	}

	const requestContext = await resolveRequestContext(c, job.request.model);
	if (requestContext.project.id !== job.projectId) {
		throw new HTTPException(404, {
			message: "Video not found",
		});
	}

	return { requestContext, job };
}

async function handleVideoCreate(c: Context) {
	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		throw new HTTPException(400, {
			message: "Invalid JSON in request body",
		});
	}

	const validationResult = videoGenerationRequestSchema.safeParse(rawBody);
	if (!validationResult.success) {
		throw new HTTPException(400, {
			message: `Invalid request parameters: ${validationResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")}`,
		});
	}

	const request = validationResult.data;
	const requestContext = await resolveRequestContext(c, request.model);
	const { apiKey, project, modelInfo, requestedProvider } = requestContext;

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
	const videoProviders = allowedProviders.filter(
		(provider) => (provider as ProviderModelMapping).videoGenerations === true,
	);
	const candidateProviders =
		requestedProvider && requestedProvider !== "llmgateway"
			? videoProviders.filter(
					(provider) => provider.providerId === requestedProvider,
				)
			: videoProviders;

	if (candidateProviders.length === 0) {
		throw new HTTPException(400, {
			message: `No video generation provider is available for model ${request.model}`,
		});
	}

	const noFallback =
		c.req.raw.headers.get("x-no-fallback") === "true" ||
		c.req.raw.headers.get("X-No-Fallback") === "true";
	const providerScores = candidateProviders.map((provider, index) => ({
		providerId: provider.providerId,
		score: index,
	}));
	const failedProviderIds = new Set<string>();
	let context: VideoProviderContext | null = null;

	for (const providerMapping of candidateProviders) {
		try {
			context = await resolveVideoProviderContext({
				providerMapping: providerMapping as ProviderModelMapping,
				projectMode: project.mode,
				organizationId: project.organizationId,
				request,
			});
			break;
		} catch {
			continue;
		}
	}

	if (!context) {
		throw new HTTPException(500, {
			message: "Failed to initialize a video generation provider",
		});
	}

	let finalJob: StoredVideoJob | null = null;
	let lastErrorStatus = 502;
	let lastErrorMessage = "All provider attempts failed";

	for (let retryAttempt = 0; retryAttempt <= MAX_RETRIES; retryAttempt++) {
		if (!context) {
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
				context = await resolveVideoProviderContext({
					providerMapping: nextProvider as ProviderModelMapping,
					projectMode: project.mode,
					organizationId: project.organizationId,
					request,
				});
			} catch {
				failedProviderIds.add(nextProvider.providerId);
				retryAttempt--;
				continue;
			}
		}

		const attemptResult = await startVideoGenerationAttempt(c, context);
		if (attemptResult.type === "success") {
			const createdAt =
				attemptResult.createdAt ?? Math.floor(Date.now() / 1000);
			const job: StoredVideoJob = {
				id: `video_${shortid()}`,
				request,
				rawRequest: rawBody,
				projectId: project.id,
				organizationId: project.organizationId,
				projectMode: project.mode,
				usedProvider: context.usedProvider,
				usedModel: context.usedModel,
				usedModelMapping: context.usedModelMapping,
				envVarName: context.envVarName,
				configIndex: context.configIndex,
				upstreamId: attemptResult.upstreamId ?? `upstream_${shortid()}`,
				createdAt,
				completedAt: attemptResult.completedAt ?? null,
				expiresAt: createdAt + VIDEO_JOB_TTL_SECONDS,
				status: attemptResult.status ?? "queued",
				progress: attemptResult.progress ?? 0,
				error: attemptResult.error ?? null,
				logged: false,
				contentUrl: attemptResult.contentUrl,
			};
			await saveVideoJob(job);

			finalJob = await maybeFinalizeVideoJob({
				requestContext,
				job,
				rawResponse: buildVideoJobResponse(job),
				upstreamResponse: attemptResult.rawResponse ?? null,
			});
			break;
		}

		if (attemptResult.type === "canceled") {
			return c.json(
				buildErrorPayload(
					"Request canceled by client",
					"request_canceled",
					"canceled",
				),
				400,
			);
		}

		const statusCode = attemptResult.statusCode ?? 0;
		const shouldRetry = shouldRetryRequest({
			requestedProvider,
			noFallback,
			statusCode,
			retryCount: retryAttempt,
			remainingProviders:
				candidateProviders.length - failedProviderIds.size - 1,
			usedProvider: context.usedProvider,
		});

		lastErrorStatus = statusCode === 400 ? 400 : 500;
		lastErrorMessage =
			attemptResult.errorText ?? "Failed to connect to provider";

		if (context.envVarName !== undefined) {
			reportKeyError(
				context.envVarName,
				context.configIndex,
				statusCode,
				attemptResult.errorText,
			);
		}

		if (shouldRetry) {
			failedProviderIds.add(context.usedProvider);
			continue;
		}

		break;
	}

	if (!finalJob) {
		return c.json(
			buildErrorPayload(
				lastErrorMessage,
				"video_generation_failed",
				"upstream_error",
			),
			lastErrorStatus === 400 ? 400 : 500,
		);
	}

	return c.json(buildVideoJobResponse(finalJob));
}

async function handleVideoGet(c: Context) {
	const { id } = c.req.param();
	const { requestContext, job } = await authorizeVideoJobAccess(c, id);

	if (job.status === "completed" || job.status === "failed") {
		const finalizedJob = await maybeFinalizeVideoJob({
			requestContext,
			job,
			rawResponse: buildVideoJobResponse(job),
			upstreamResponse: null,
		});
		return c.json(buildVideoJobResponse(finalizedJob));
	}

	const refreshResult = await refreshVideoJobStatus(c, requestContext, job);
	const finalizedJob = await maybeFinalizeVideoJob({
		requestContext,
		job: refreshResult.job,
		rawResponse: buildVideoJobResponse(refreshResult.job),
		upstreamResponse: refreshResult.upstreamResponse,
	});

	return c.json(buildVideoJobResponse(finalizedJob));
}

async function proxyRemoteContent(url: string): Promise<Response> {
	if (!url.startsWith("http://") && !url.startsWith("https://")) {
		throw new HTTPException(502, {
			message: `Unsupported video content URL: ${url}`,
		});
	}

	const response = await fetch(url);
	if (!response.ok) {
		throw new HTTPException(response.status === 400 ? 400 : 500, {
			message: await response.text(),
		});
	}

	const headers = new Headers();
	headers.set(
		"Content-Type",
		response.headers.get("Content-Type") ?? "video/mp4",
	);
	return new Response(response.body, {
		status: 200,
		headers,
	});
}

async function handleVideoContent(c: Context) {
	const { id } = c.req.param();
	const { requestContext, job: initialJob } = await authorizeVideoJobAccess(
		c,
		id,
	);
	let job = initialJob;
	let refreshResult: VideoStatusRefreshResult | null = null;

	if (job.status !== "completed") {
		refreshResult = await refreshVideoJobStatus(c, requestContext, job);
		job = refreshResult.job;
	}

	job = await maybeFinalizeVideoJob({
		requestContext,
		job,
		rawResponse: buildVideoJobResponse(job),
		upstreamResponse: refreshResult?.upstreamResponse ?? null,
	});

	if (job.status !== "completed") {
		return c.json(
			buildErrorPayload(
				"Video is not completed yet",
				"video_not_ready",
				"invalid_request_error",
			),
			409,
		);
	}

	const context = await resolveJobProviderContext(requestContext, job);

	switch (job.usedProvider) {
		case "tuzi":
		case "openai": {
			const dispatcher = createProxyAgent(
				context.url,
				context.useProxy,
				context.providerKey,
			);
			const requestOptions: RequestInit & { dispatcher?: unknown } = {
				method: "GET",
				headers: context.headers,
				signal: c.req.raw.signal,
			};
			if (dispatcher) {
				requestOptions.dispatcher = dispatcher;
			}

			const response = await fetch(
				buildOpenAIVideoContentUrl(context, job.upstreamId),
				requestOptions,
			);
			if (!response.ok) {
				return c.json(
					buildErrorPayload(
						await response.text(),
						"video_content_failed",
						"upstream_error",
					),
					response.status === 400 ? 400 : 500,
				);
			}

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("application/json")) {
				const payload = (await response.json()) as unknown;
				if (!isRecord(payload)) {
					throw new HTTPException(502, {
						message: "OpenAI video content response was not a valid object",
					});
				}

				if (typeof payload.b64_json === "string") {
					return new Response(Buffer.from(payload.b64_json, "base64"), {
						status: 200,
						headers: {
							"Content-Type": "video/mp4",
						},
					});
				}

				const url =
					typeof payload.url === "string"
						? payload.url
						: typeof payload.download_url === "string"
							? payload.download_url
							: null;
				if (!url) {
					throw new HTTPException(502, {
						message:
							"OpenAI video content response did not include a downloadable asset",
					});
				}
				return await proxyRemoteContent(url);
			}
			return new Response(response.body, {
				status: 200,
				headers: {
					"Content-Type": contentType || "video/mp4",
				},
			});
		}
		case "google-vertex":
		case "google-ai-studio": {
			const contentHint =
				refreshResult?.contentHint ??
				(job.contentUrl
					? {
							type: "url" as const,
							value: job.contentUrl,
						}
					: null);
			if (!contentHint) {
				return c.json(
					buildErrorPayload(
						"Completed video did not include downloadable content",
						"video_content_missing",
						"upstream_error",
					),
					500,
				);
			}

			if (contentHint.type === "b64_json") {
				return new Response(Buffer.from(contentHint.value, "base64"), {
					status: 200,
					headers: {
						"Content-Type": contentHint.mimeType ?? "video/mp4",
					},
				});
			}

			return await proxyRemoteContent(contentHint.value);
		}
		default:
			throw new HTTPException(500, {
				message: `Unsupported provider: ${job.usedProvider}`,
			});
	}
}

export const videos = new OpenAPIHono<ServerTypes>();

videos.post("/", handleVideoCreate);
videos.post("/generations", handleVideoCreate);
videos.get("/:id/content", handleVideoContent);
videos.get("/:id", handleVideoGet);
