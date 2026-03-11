import { encode } from "gpt-tokenizer";

import { convertImagesToBase64 } from "@/chat/tools/convert-images-to-base64.js";
import { estimateTokensFromContent } from "@/chat/tools/estimate-tokens-from-content.js";
import { estimateTokens } from "@/chat/tools/estimate-tokens.js";
import { healJsonResponse } from "@/chat/tools/heal-json-response.js";
import { parseProviderResponse } from "@/chat/tools/parse-provider-response.js";
import { messageContentToString } from "@/chat/tools/tokenizer.js";
import { calculateCosts } from "@/lib/costs.js";

import { logger } from "@llmgateway/logger";

import type { BaseMessage, Provider } from "@llmgateway/models";

export interface ProcessNonStreamingProviderResponseOptions {
	response: Response;
	usedProvider: Provider;
	usedModel: string;
	messages: BaseMessage[];
	responseFormat?:
		| {
				type: "text" | "json_object" | "json_schema";
		  }
		| undefined;
	responseHealingEnabled?: boolean;
	inputImageCount: number;
	imageSize?: string;
	organizationId: string;
}

export interface ProcessNonStreamingProviderResponseResult {
	json: any;
	responseSize: number;
	content: string | null;
	reasoningContent: string | null;
	finishReason: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | string | null;
	reasoningTokens: number | null;
	cachedTokens: number | null;
	toolResults: any;
	convertedImages: any[];
	annotations: any[] | null;
	webSearchCount: number | null;
	calculatedPromptTokens: number | null;
	calculatedCompletionTokens: number | null;
	calculatedReasoningTokens: number | null;
	costs: Awaited<ReturnType<typeof calculateCosts>>;
	pluginResults: {
		responseHealing?: {
			healed: boolean;
			healingMethod?: string;
		};
	};
}

export async function processNonStreamingProviderResponse(
	options: ProcessNonStreamingProviderResponseOptions,
): Promise<ProcessNonStreamingProviderResponseResult> {
	const {
		response,
		usedProvider,
		usedModel,
		messages,
		responseFormat,
		responseHealingEnabled = false,
		inputImageCount,
		imageSize,
		organizationId,
	} = options;

	const json = await response.json();
	const contentLengthHeader = response.headers.get("Content-Length");
	let responseSize = contentLengthHeader
		? parseInt(contentLengthHeader, 10)
		: 0;

	const parsedResponse = parseProviderResponse(
		usedProvider,
		usedModel,
		json,
		messages,
	);
	let { content, totalTokens } = parsedResponse;
	const {
		reasoningContent,
		finishReason,
		promptTokens,
		completionTokens,
		reasoningTokens,
		cachedTokens,
		toolResults,
		images,
		annotations,
		webSearchCount,
	} = parsedResponse;

	const isJsonResponseFormat =
		responseFormat?.type === "json_object" ||
		responseFormat?.type === "json_schema";
	const pluginResults: {
		responseHealing?: {
			healed: boolean;
			healingMethod?: string;
		};
	} = {};

	if (responseHealingEnabled && isJsonResponseFormat && content) {
		const healingResult = healJsonResponse(content);
		pluginResults.responseHealing = {
			healed: healingResult.healed,
			healingMethod: healingResult.healingMethod,
		};
		if (healingResult.healed) {
			content = healingResult.content;
		}
	}

	let convertedImages = images;
	if (images && images.length > 0) {
		convertedImages = await convertImagesToBase64(images);
	}

	const estimatedTokens = estimateTokens(
		usedProvider,
		messages,
		content,
		promptTokens,
		completionTokens,
	);
	let calculatedPromptTokens = estimatedTokens.calculatedPromptTokens;
	const calculatedCompletionTokens = estimatedTokens.calculatedCompletionTokens;

	let calculatedReasoningTokens = reasoningTokens;
	if (!reasoningTokens && reasoningContent) {
		try {
			calculatedReasoningTokens = encode(reasoningContent).length;
		} catch (error) {
			logger.error(
				"Failed to encode reasoning text",
				error instanceof Error ? error : new Error(String(error)),
			);
			calculatedReasoningTokens = estimateTokensFromContent(reasoningContent);
		}
	}

	const costs = await calculateCosts(
		usedModel,
		usedProvider,
		calculatedPromptTokens,
		calculatedCompletionTokens,
		cachedTokens,
		{
			prompt: messages.map((m) => messageContentToString(m.content)).join("\n"),
			completion: content,
			toolResults,
		},
		reasoningTokens,
		convertedImages?.length || 0,
		imageSize,
		inputImageCount,
		webSearchCount,
		organizationId,
	);

	if (costs.promptTokens !== null && costs.promptTokens !== undefined) {
		const promptDelta =
			(costs.promptTokens ?? 0) - (calculatedPromptTokens ?? 0);
		if (promptDelta > 0) {
			calculatedPromptTokens = costs.promptTokens;
			totalTokens = (
				(calculatedPromptTokens ?? 0) +
				(calculatedCompletionTokens ?? 0) +
				(calculatedReasoningTokens ?? 0)
			).toString();
		}
	}

	if (!responseSize) {
		const contentLength = content?.length ?? 0;
		if (contentLength > 1_000_000) {
			responseSize = contentLength + 500;
		} else {
			responseSize = JSON.stringify(json).length;
		}
	}

	return {
		json,
		responseSize,
		content,
		reasoningContent,
		finishReason,
		promptTokens,
		completionTokens,
		totalTokens,
		reasoningTokens,
		cachedTokens,
		toolResults,
		convertedImages,
		annotations,
		webSearchCount,
		calculatedPromptTokens,
		calculatedCompletionTokens,
		calculatedReasoningTokens,
		costs,
		pluginResults,
	};
}
