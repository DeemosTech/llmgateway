import { createProxyAgent } from "@/chat/tools/create-proxy-agent.js";
import { estimateTokens } from "@/chat/tools/estimate-tokens.js";
import { extractErrorCause } from "@/chat/tools/extract-error-cause.js";
import { getFinishReasonFromError } from "@/chat/tools/get-finish-reason-from-error.js";
import { messageContentToString } from "@/chat/tools/tokenizer.js";
import { reportKeyError } from "@/lib/api-key-health.js";
import { calculateCosts, shouldBillCancelledRequests } from "@/lib/costs.js";
import { calculateDataStorageCost, insertLog } from "@/lib/logs.js";
import { createCombinedSignal, isTimeoutError } from "@/lib/timeout-config.js";

import type { createLogEntry } from "@/chat/tools/create-log-entry.js";
import type { resolveProviderContext } from "@/chat/tools/resolve-provider-context.js";
import type { BaseMessage } from "@llmgateway/models";

type BaseLogEntry = ReturnType<typeof createLogEntry>;
type ResolvedProviderContext = Awaited<
	ReturnType<typeof resolveProviderContext>
>;

export type NonStreamingAttemptResult =
	| {
			type: "success";
			response: Response;
			duration: number;
	  }
	| {
			type: "fetch_error";
			isTimeout: boolean;
			message: string;
			statusCode: number;
			duration: number;
	  }
	| {
			type: "canceled";
			duration: number;
	  }
	| {
			type: "http_error";
			status: number;
			statusText: string;
			errorText: string;
			finishReason: string;
			duration: number;
	  };

export interface ExecuteNonStreamingAttemptOptions {
	requestSignal: AbortSignal;
	resolvedContext: ResolvedProviderContext;
	upstreamRequestBody: unknown;
	createBaseLogEntry: (
		rawResponse: unknown,
		upstreamResponse: unknown,
	) => BaseLogEntry;
	messages: BaseMessage[];
	inputImageCount: number;
	webSearchEnabled: boolean;
	organizationId: string;
	retentionLevel?: "retain" | "none" | null;
	getRetryMetadata?: (result: {
		type: "fetch_error" | "http_error";
		statusCode: number;
		finishReason?: string;
	}) => {
		retried?: boolean;
		retriedByLogId?: string | null;
	};
}

export async function executeNonStreamingAttempt(
	options: ExecuteNonStreamingAttemptOptions,
): Promise<NonStreamingAttemptResult> {
	const {
		requestSignal,
		resolvedContext,
		upstreamRequestBody,
		createBaseLogEntry,
		messages,
		inputImageCount,
		webSearchEnabled,
		organizationId,
		retentionLevel,
		getRetryMetadata,
	} = options;

	const controller = new AbortController();
	let canceled = false;
	const onAbort = () => {
		if (resolvedContext.requestCanBeCanceled) {
			canceled = true;
			controller.abort();
		}
	};
	requestSignal.addEventListener("abort", onAbort);

	const startedAt = Date.now();

	try {
		const dispatcher = createProxyAgent(
			resolvedContext.url,
			resolvedContext.useProxy,
			resolvedContext.providerKey,
		);
		const fetchOptions: RequestInit & { dispatcher?: unknown } = {
			method: "POST",
			headers: resolvedContext.headers,
			body: JSON.stringify(upstreamRequestBody),
			signal: createCombinedSignal(
				resolvedContext.requestCanBeCanceled ? controller : undefined,
			),
		};
		if (dispatcher) {
			fetchOptions.dispatcher = dispatcher;
		}

		const response = await fetch(resolvedContext.url, fetchOptions);
		const duration = Date.now() - startedAt;

		if (!response.ok) {
			const errorText = await response.text();
			const finishReason = getFinishReasonFromError(response.status, errorText);
			const retryMetadata = getRetryMetadata?.({
				type: "http_error",
				statusCode: response.status,
				finishReason,
			});

			await insertLog({
				...createBaseLogEntry(errorText, errorText),
				duration,
				timeToFirstToken: null,
				timeToFirstReasoningToken: null,
				responseSize: errorText.length,
				content: null,
				reasoningContent: null,
				finishReason,
				promptTokens: null,
				completionTokens: null,
				totalTokens: null,
				reasoningTokens: null,
				cachedTokens: null,
				hasError: finishReason !== "content_filter",
				streamed: false,
				canceled: false,
				errorDetails:
					finishReason === "content_filter"
						? null
						: {
								statusCode: response.status,
								statusText: response.statusText,
								responseText: errorText,
							},
				cachedInputCost: null,
				requestCost: null,
				webSearchCost: null,
				imageInputTokens: null,
				imageOutputTokens: null,
				imageInputCost: null,
				imageOutputCost: null,
				estimatedCost: false,
				discount: null,
				dataStorageCost: "0",
				cached: false,
				toolResults: null,
				retried: retryMetadata?.retried,
				retriedByLogId: retryMetadata?.retriedByLogId ?? null,
			});

			if (
				resolvedContext.envVarName !== undefined &&
				finishReason !== "content_filter"
			) {
				reportKeyError(
					resolvedContext.envVarName,
					resolvedContext.configIndex,
					response.status,
					errorText,
				);
			}

			return {
				type: "http_error",
				status: response.status,
				statusText: response.statusText,
				errorText,
				finishReason,
				duration,
			};
		}

		return {
			type: "success",
			response,
			duration,
		};
	} catch (error) {
		const duration = Date.now() - startedAt;

		if (canceled || (error instanceof Error && error.name === "AbortError")) {
			const billCancelled = shouldBillCancelledRequests();
			let cancelledCosts: Awaited<ReturnType<typeof calculateCosts>> | null =
				null;
			let estimatedPromptTokens: number | null = null;

			if (billCancelled) {
				const tokenEstimation = estimateTokens(
					resolvedContext.usedProvider,
					messages,
					null,
					null,
					null,
				);
				estimatedPromptTokens = tokenEstimation.calculatedPromptTokens;

				cancelledCosts = await calculateCosts(
					resolvedContext.usedModel,
					resolvedContext.usedProvider,
					estimatedPromptTokens,
					0,
					null,
					{
						prompt: messages
							.map((message) => messageContentToString(message.content))
							.join("\n"),
						completion: "",
					},
					null,
					0,
					undefined,
					inputImageCount,
					webSearchEnabled ? 1 : null,
					organizationId,
				);
			}

			await insertLog({
				...createBaseLogEntry(null, null),
				duration,
				timeToFirstToken: null,
				timeToFirstReasoningToken: null,
				responseSize: 0,
				content: null,
				reasoningContent: null,
				finishReason: "canceled",
				promptTokens: billCancelled
					? (cancelledCosts?.promptTokens ?? estimatedPromptTokens)?.toString()
					: null,
				completionTokens: billCancelled ? "0" : null,
				totalTokens: billCancelled
					? (cancelledCosts?.promptTokens ?? estimatedPromptTokens)?.toString()
					: null,
				reasoningTokens: null,
				cachedTokens: null,
				hasError: false,
				streamed: false,
				canceled: true,
				errorDetails: null,
				inputCost: cancelledCosts?.inputCost ?? null,
				outputCost: cancelledCosts?.outputCost ?? null,
				cachedInputCost: cancelledCosts?.cachedInputCost ?? null,
				requestCost: cancelledCosts?.requestCost ?? null,
				webSearchCost: cancelledCosts?.webSearchCost ?? null,
				imageInputTokens: cancelledCosts?.imageInputTokens?.toString() ?? null,
				imageOutputTokens:
					cancelledCosts?.imageOutputTokens?.toString() ?? null,
				imageInputCost: cancelledCosts?.imageInputCost ?? null,
				imageOutputCost: cancelledCosts?.imageOutputCost ?? null,
				cost: cancelledCosts?.totalCost ?? null,
				estimatedCost: cancelledCosts?.estimatedCost ?? false,
				discount: cancelledCosts?.discount ?? null,
				dataStorageCost: billCancelled
					? calculateDataStorageCost(
							cancelledCosts?.promptTokens ?? estimatedPromptTokens,
							null,
							0,
							null,
							retentionLevel,
						)
					: "0",
				cached: false,
				toolResults: null,
			});

			return {
				type: "canceled",
				duration,
			};
		}

		const errorMessage =
			error instanceof Error ? error.message : "Failed to connect to provider";
		const errorCause = extractErrorCause(error);
		const isTimeout = isTimeoutError(error);
		const retryMetadata = getRetryMetadata?.({
			type: "fetch_error",
			statusCode: 0,
		});

		await insertLog({
			...createBaseLogEntry(null, null),
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
				statusCode: 0,
				statusText: error instanceof Error ? error.name : "Error",
				responseText: errorMessage,
				cause: errorCause,
			},
			cachedInputCost: null,
			requestCost: null,
			webSearchCost: null,
			imageInputTokens: null,
			imageOutputTokens: null,
			imageInputCost: null,
			imageOutputCost: null,
			estimatedCost: false,
			discount: null,
			dataStorageCost: "0",
			cached: false,
			toolResults: null,
			retried: retryMetadata?.retried,
			retriedByLogId: retryMetadata?.retriedByLogId ?? null,
		});

		if (resolvedContext.envVarName !== undefined) {
			reportKeyError(
				resolvedContext.envVarName,
				resolvedContext.configIndex,
				0,
			);
		}

		return {
			type: "fetch_error",
			isTimeout,
			message: errorMessage,
			statusCode: 0,
			duration,
		};
	} finally {
		requestSignal.removeEventListener("abort", onAbort);
	}
}
