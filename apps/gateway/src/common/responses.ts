import { countInputImages } from "@/chat/tools/count-input-images.js";
import { createLogEntry } from "@/chat/tools/create-log-entry.js";

import type { resolveProviderContext } from "@/chat/tools/resolve-provider-context.js";
import type { resolveRequestContext } from "@/common/resolve-request-context.js";
import type { BaseMessage, Provider, WebSearchTool } from "@llmgateway/models";

export interface ResponsesRequestShape {
	model: string;
	input?: unknown;
	instructions?: unknown;
	temperature?: number | null;
	top_p?: number | null;
	max_output_tokens?: number | null;
	max_tokens?: number | null;
	tools?: unknown;
	tool_choice?: unknown;
	parallel_tool_calls?: boolean;
	reasoning?:
		| {
				effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
				max_tokens?: number;
		  }
		| undefined;
	text?:
		| {
				format?:
					| {
							type: "text" | "json_object";
					  }
					| {
							type: "json_schema";
							name: string;
							description?: string;
							schema: Record<string, unknown>;
							strict?: boolean;
					  };
		  }
		| undefined;
	stream?: boolean;
	metadata?: Record<string, unknown> | null;
	previous_response_id?: string | null;
	user?: string;
}

export type ChatRequestResponseFormat =
	| {
			type: "text" | "json_object" | "json_schema";
			json_schema?: {
				name: string;
				description?: string;
				schema: Record<string, unknown>;
				strict?: boolean;
			};
	  }
	| undefined;

export interface ChatFunctionTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface DirectResponsesArtifacts {
	chatRequest: Record<string, unknown>;
	messages: BaseMessage[];
	responseFormat: ChatRequestResponseFormat;
	reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
	reasoningMaxTokens: number | undefined;
	chatTools: ChatFunctionTool[] | undefined;
	webSearchTool: WebSearchTool | undefined;
	inputImageCount: number;
}

function convertInputItemToMessage(
	item: Record<string, unknown>,
): Record<string, unknown> {
	return {
		role: item.role === "developer" ? "system" : (item.role ?? "user"),
		content: convertContentToChatFormat(item.content),
	};
}

function convertContentToChatFormat(content: unknown): unknown {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return content;
	}

	return content.map((part) => {
		if (!part || typeof part !== "object") {
			return part;
		}

		const typedPart = part as Record<string, unknown>;
		if (typedPart.type === "input_text" || typedPart.type === "text") {
			return {
				type: "text",
				text: typedPart.text,
			};
		}

		if (typedPart.type === "input_image" || typedPart.type === "image_url") {
			let imageUrl = typedPart.image_url;
			if (typeof imageUrl === "string") {
				imageUrl = { url: imageUrl };
			}

			return {
				type: "image_url",
				image_url: imageUrl,
			};
		}

		return part;
	});
}

function convertInputToMessages(
	input: unknown,
	instructions: unknown,
): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];

	if (instructions !== undefined && instructions !== null) {
		if (typeof instructions === "string") {
			messages.push({
				role: "system",
				content: instructions,
			});
		} else if (Array.isArray(instructions)) {
			for (const item of instructions) {
				if (item && typeof item === "object") {
					messages.push(
						convertInputItemToMessage(item as Record<string, unknown>),
					);
				}
			}
		}
	}

	if (input !== undefined && input !== null) {
		if (typeof input === "string") {
			messages.push({
				role: "user",
				content: input,
			});
		} else if (Array.isArray(input)) {
			for (const item of input) {
				if (item && typeof item === "object" && "type" in item) {
					const typedItem = item as Record<string, unknown>;
					if (typedItem.type === "function_call") {
						messages.push({
							role: "assistant",
							content: "",
							tool_calls: [
								{
									id: typedItem.call_id,
									type: "function",
									function: {
										name: typedItem.name,
										arguments: typedItem.arguments,
									},
								},
							],
						});
						continue;
					}

					if (typedItem.type === "function_call_output") {
						messages.push({
							role: "tool",
							tool_call_id: typedItem.call_id,
							content: typedItem.output ?? "",
						});
						continue;
					}
				}

				if (item && typeof item === "object") {
					messages.push(
						convertInputItemToMessage(item as Record<string, unknown>),
					);
				}
			}
		}
	}

	return messages;
}

function convertToolsToChatFormat(tools: unknown): unknown {
	if (!tools || !Array.isArray(tools)) {
		return undefined;
	}

	return tools.map((tool) => {
		if (!tool || typeof tool !== "object") {
			return tool;
		}

		const typedTool = tool as Record<string, unknown>;
		if (typedTool.type === "function") {
			return {
				type: "function" as const,
				function: {
					name: typedTool.name,
					description: typedTool.description,
					parameters: typedTool.parameters,
				},
			};
		}

		if (typedTool.type === "web_search_preview") {
			return {
				...typedTool,
				type: "web_search" as const,
			};
		}

		return tool;
	});
}

function convertToolChoiceToChatFormat(toolChoice: unknown): unknown {
	if (!toolChoice) {
		return undefined;
	}

	if (typeof toolChoice === "string") {
		return toolChoice;
	}

	if (
		typeof toolChoice === "object" &&
		toolChoice !== null &&
		"type" in toolChoice &&
		(toolChoice as { type?: unknown }).type === "function"
	) {
		return {
			type: "function" as const,
			function: {
				name: (toolChoice as { name?: string }).name,
			},
		};
	}

	return toolChoice;
}

function convertReasoningToChatFormat(reasoning: unknown): {
	reasoning_effort?: string;
	reasoning?: Record<string, unknown>;
} {
	if (!reasoning || typeof reasoning !== "object") {
		return {};
	}

	const typedReasoning = reasoning as {
		effort?: string;
		max_tokens?: number;
	};
	const result: {
		reasoning_effort?: string;
		reasoning?: Record<string, unknown>;
	} = {};

	if (typedReasoning.effort && typedReasoning.effort !== "none") {
		result.reasoning_effort = typedReasoning.effort;
	}

	if (typedReasoning.effort || typedReasoning.max_tokens !== undefined) {
		result.reasoning = {
			...(typedReasoning.effort && { effort: typedReasoning.effort }),
			...(typedReasoning.max_tokens !== undefined && {
				max_tokens: typedReasoning.max_tokens,
			}),
		};
	}

	return result;
}

function convertTextConfigToResponseFormat(text: unknown): unknown {
	if (!text || typeof text !== "object" || !("format" in text)) {
		return undefined;
	}

	const format = (text as { format?: unknown }).format;
	if (!format || typeof format !== "object") {
		return undefined;
	}

	const typedFormat = format as Record<string, unknown>;
	if (typedFormat.type === "text") {
		return { type: "text" };
	}
	if (typedFormat.type === "json_object") {
		return { type: "json_object" };
	}
	if (typedFormat.type === "json_schema") {
		return {
			type: "json_schema",
			json_schema: {
				name: typedFormat.name,
				description: typedFormat.description,
				schema: typedFormat.schema,
				strict: typedFormat.strict,
			},
		};
	}

	return undefined;
}

export function convertToChatCompletionsRequest(
	request: ResponsesRequestShape,
): Record<string, unknown> {
	const chatRequest: Record<string, unknown> = {
		model: request.model,
		messages: convertInputToMessages(request.input, request.instructions),
		stream: request.stream ?? false,
	};

	if (request.temperature !== undefined && request.temperature !== null) {
		chatRequest.temperature = request.temperature;
	}

	if (request.top_p !== undefined && request.top_p !== null) {
		chatRequest.top_p = request.top_p;
	}

	const maxTokens = request.max_output_tokens ?? request.max_tokens;
	if (maxTokens !== undefined && maxTokens !== null) {
		chatRequest.max_tokens = maxTokens;
	}

	const tools = convertToolsToChatFormat(request.tools);
	if (tools) {
		chatRequest.tools = tools;
	}

	const toolChoice = convertToolChoiceToChatFormat(request.tool_choice);
	if (toolChoice) {
		chatRequest.tool_choice = toolChoice;
	}

	const reasoningConfig = convertReasoningToChatFormat(request.reasoning);
	if (reasoningConfig.reasoning_effort) {
		chatRequest.reasoning_effort = reasoningConfig.reasoning_effort;
	} else if (reasoningConfig.reasoning) {
		chatRequest.reasoning = reasoningConfig.reasoning;
	}

	const responseFormat = convertTextConfigToResponseFormat(request.text);
	if (responseFormat) {
		chatRequest.response_format = responseFormat;
	}

	if (request.user) {
		chatRequest.user = request.user;
	}

	return chatRequest;
}

export function extractWebSearchTool(
	tools: Record<string, unknown>[] | undefined,
): {
	tools: Record<string, unknown>[] | undefined;
	webSearchTool: WebSearchTool | undefined;
} {
	if (!tools || tools.length === 0) {
		return {
			tools,
			webSearchTool: undefined,
		};
	}

	const nextTools = [...tools];
	const webSearchIndex = nextTools.findIndex(
		(tool) => tool.type === "web_search",
	);
	if (webSearchIndex === -1) {
		return {
			tools: nextTools,
			webSearchTool: undefined,
		};
	}

	const foundTool = nextTools[webSearchIndex];
	nextTools.splice(webSearchIndex, 1);

	return {
		tools: nextTools,
		webSearchTool: {
			type: "web_search",
			user_location: foundTool.user_location as
				| {
						type: "approximate";
						city?: string;
						country?: string;
						region?: string;
						timezone?: string;
				  }
				| undefined,
			search_context_size: foundTool.search_context_size as
				| "low"
				| "medium"
				| "high"
				| undefined,
			max_uses: foundTool.max_uses as number | undefined,
		},
	};
}

export function createDirectResponsesArtifacts(
	request: ResponsesRequestShape,
): DirectResponsesArtifacts {
	const chatRequest = convertToChatCompletionsRequest(request);
	const messages = (chatRequest.messages ?? []) as BaseMessage[];
	const responseFormat =
		chatRequest.response_format as ChatRequestResponseFormat;
	const reasoningEffort = chatRequest.reasoning_effort as
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| undefined;
	const reasoningMaxTokens =
		typeof request.reasoning?.max_tokens === "number"
			? request.reasoning.max_tokens
			: undefined;
	const extractedTools = extractWebSearchTool(
		chatRequest.tools as Record<string, unknown>[] | undefined,
	);

	return {
		chatRequest,
		messages,
		responseFormat,
		reasoningEffort,
		reasoningMaxTokens,
		chatTools: extractedTools.tools as ChatFunctionTool[] | undefined,
		webSearchTool: extractedTools.webSearchTool,
		inputImageCount: countInputImages(messages),
	};
}

export function createDirectResponsesBaseLogEntry(
	requestContext: Awaited<ReturnType<typeof resolveRequestContext>>,
	request: ResponsesRequestShape,
	artifacts: DirectResponsesArtifacts,
	resolvedContext: Awaited<ReturnType<typeof resolveProviderContext>>,
	rawRequest: unknown,
	rawResponse: unknown,
	upstreamRequest: unknown,
	upstreamResponse: unknown,
) {
	return createLogEntry(
		requestContext.requestId,
		requestContext.project,
		requestContext.apiKey,
		resolvedContext.providerKey?.id,
		resolvedContext.usedModelFormatted,
		resolvedContext.usedModelMapping,
		resolvedContext.usedProvider,
		request.model,
		requestContext.requestedProvider,
		artifacts.messages,
		artifacts.chatRequest.temperature as number | undefined,
		artifacts.chatRequest.max_tokens as number | undefined,
		artifacts.chatRequest.top_p as number | undefined,
		undefined,
		undefined,
		artifacts.reasoningEffort,
		artifacts.reasoningMaxTokens,
		undefined,
		artifacts.responseFormat,
		artifacts.chatTools,
		artifacts.chatRequest.tool_choice,
		requestContext.source,
		requestContext.customHeaders,
		requestContext.debugMode,
		requestContext.userAgent,
		undefined,
		undefined,
		rawRequest,
		rawResponse,
		upstreamRequest,
		upstreamResponse,
	);
}

function extractOutputText(output: unknown): string {
	if (!Array.isArray(output)) {
		return "";
	}

	return output
		.flatMap((item) => {
			if (!item || typeof item !== "object") {
				return [];
			}

			const content = (item as { content?: unknown }).content;
			if (!Array.isArray(content)) {
				return [];
			}

			return content
				.filter(
					(part) =>
						part &&
						typeof part === "object" &&
						"type" in part &&
						((part as { type?: string }).type === "output_text" ||
							(part as { type?: string }).type === "text"),
				)
				.map((part) => (part as { text?: string }).text ?? "");
		})
		.join("");
}

export function normalizeResponsesApiResponse(
	json: Record<string, unknown>,
	request: ResponsesRequestShape,
	modelInfoId: string,
	usedProvider: Provider,
	usedModel: string,
	routing?: Array<Record<string, unknown>>,
): Record<string, unknown> {
	const output = Array.isArray(json.output) ? json.output : [];
	const outputText =
		typeof json.output_text === "string"
			? json.output_text
			: extractOutputText(output);

	const metadata =
		json.metadata && typeof json.metadata === "object"
			? { ...(json.metadata as Record<string, unknown>) }
			: {};

	return {
		...json,
		object: json.object ?? "response",
		created_at:
			typeof json.created_at === "number"
				? json.created_at
				: Math.floor(Date.now() / 1000),
		model: request.model,
		status: typeof json.status === "string" ? json.status : "completed",
		output,
		output_text: outputText,
		metadata: {
			...metadata,
			requested_model: request.model,
			requested_provider: request.model.includes("/")
				? request.model.split("/")[0]
				: null,
			used_model: modelInfoId,
			used_provider: usedProvider,
			underlying_used_model: usedModel,
			...(routing && routing.length > 0 ? { routing } : {}),
		},
	};
}

export function convertToResponsesResponse(
	chatResponse: {
		id?: string;
		created?: number;
		choices?: Array<{
			message?: {
				content?: unknown;
			};
		}>;
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
			reasoning_tokens?: number;
		};
	},
	requestModel: string,
) {
	const choices = chatResponse.choices ?? [];
	const content = choices[0]?.message?.content ?? "";

	let outputText = "";
	if (typeof content === "string") {
		outputText = content;
	} else if (Array.isArray(content)) {
		outputText = content
			.filter(
				(part) =>
					part &&
					typeof part === "object" &&
					((part as { type?: string }).type === "text" ||
						(part as { type?: string }).type === "output_text"),
			)
			.map((part) => (part as { text?: string }).text ?? "")
			.join("");
	}

	const output: Array<Record<string, unknown>> = [
		{
			type: "message",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: outputText,
				},
			],
		},
	];

	let usage:
		| {
				input_tokens: number;
				output_tokens: number;
				total_tokens: number;
				reasoning_tokens?: number;
		  }
		| undefined;
	if (chatResponse.usage) {
		usage = {
			input_tokens: chatResponse.usage.prompt_tokens ?? 0,
			output_tokens: chatResponse.usage.completion_tokens ?? 0,
			total_tokens: chatResponse.usage.total_tokens ?? 0,
		};
		if (chatResponse.usage.reasoning_tokens !== undefined) {
			usage.reasoning_tokens = chatResponse.usage.reasoning_tokens;
		}
	}

	return {
		id: chatResponse.id?.startsWith("resp-")
			? chatResponse.id
			: `resp-${Date.now()}`,
		object: "response" as const,
		created_at: chatResponse.created ?? Math.floor(Date.now() / 1000),
		model: requestModel,
		status: "completed" as const,
		output,
		output_text: outputText,
		usage,
	};
}

export function forwardRequestHeaders(headers: {
	authorization?: string;
	xApiKey?: string;
	userAgent?: string;
	requestId?: string;
	source?: string;
	debug?: string;
	httpReferer?: string;
}): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: headers.authorization ?? "",
		"x-api-key": headers.xApiKey ?? "",
		"User-Agent": headers.userAgent ?? "",
		"x-request-id": headers.requestId ?? "",
		"x-source": headers.source ?? "",
		"x-debug": headers.debug ?? "",
		"HTTP-Referer": headers.httpReferer ?? "",
	};
}
