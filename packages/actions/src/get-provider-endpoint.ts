import {
	models,
	type ProviderModelMapping,
	type ProviderId,
	getProviderEnvValue,
	getProviderEnvConfig,
} from "@llmgateway/models";

import type { ProviderKeyOptions } from "@llmgateway/db";

function supportResponsesApi(provider: ProviderId, model?: string): boolean {
	if (!model) {
		return false;
	}
	// Look up by model ID first, then fall back to provider modelName
	const modelDef = models.find(
		(m) =>
			m.id === model ||
			m.providers.some(
				(p) => p.modelName === model && p.providerId === provider,
			),
	);
	const providerMapping = modelDef?.providers.find(
		(p) => p.providerId === provider,
	);
	return (
		(providerMapping as ProviderModelMapping)?.supportsResponsesApi === true
	);
}

function resolveProviderBaseUrl(
	provider: ProviderId,
	baseUrl?: string,
	configIndex?: number,
	imageGenerations?: boolean,
	providerKeyOptions?: ProviderKeyOptions,
	model?: string,
): string {
	if (baseUrl) {
		return baseUrl;
	}

	switch (provider) {
		case "llmgateway":
			if (model === "custom" || model === "auto") {
				return "https://api.openai.com";
			}
			throw new Error(`Provider ${provider} requires a baseUrl`);
		case "openai":
			return "https://api.openai.com";
		case "anthropic":
			return "https://api.anthropic.com";
		case "google-ai-studio":
			return "https://generativelanguage.googleapis.com";
		case "google-vertex":
			return "https://aiplatform.googleapis.com";
		case "obsidian": {
			const resolvedUrl = getProviderEnvValue(
				"obsidian",
				"baseUrl",
				configIndex,
			);
			if (!resolvedUrl) {
				throw new Error(
					"Obsidian provider requires LLM_OBSIDIAN_BASE_URL environment variable",
				);
			}
			return resolvedUrl;
		}
		case "inference.net":
			return "https://api.inference.net";
		case "together.ai":
			return "https://api.together.ai";
		case "mistral":
			return "https://api.mistral.ai";
		case "xai":
			return "https://api.x.ai";
		case "groq":
			return "https://api.groq.com/openai";
		case "cerebras":
			return "https://api.cerebras.ai";
		case "deepseek":
			return "https://api.deepseek.com";
		case "perplexity":
			return "https://api.perplexity.ai";
		case "novita":
			return "https://api.novita.ai/v3/openai";
		case "tuzi":
			return "https://api.tu-zi.com";
		case "moonshot":
			return "https://api.moonshot.ai";
		case "alibaba":
			return imageGenerations
				? "https://dashscope.aliyuncs.com"
				: "https://dashscope.aliyuncs.com/compatible-mode";
		case "nebius":
			return "https://api.studio.nebius.com";
		case "zai":
			return "https://api.z.ai";
		case "nanogpt":
			return "https://nano-gpt.com/api";
		case "bytedance":
			return "https://ark.cn-beijing.volces.com/api/v3";
		case "minimax":
			return "https://api.minimax.io";
		case "aws-bedrock":
			return (
				getProviderEnvValue(
					"aws-bedrock",
					"baseUrl",
					configIndex,
					"https://bedrock-runtime.us-east-1.amazonaws.com",
				) ?? "https://bedrock-runtime.us-east-1.amazonaws.com"
			);
		case "azure": {
			const resource =
				providerKeyOptions?.azure_resource ??
				getProviderEnvValue("azure", "resource", configIndex);
			if (!resource) {
				const azureEnv = getProviderEnvConfig("azure");
				throw new Error(
					`Azure resource is required - set via provider options or ${azureEnv?.required.resource ?? "LLM_AZURE_RESOURCE"} env var`,
				);
			}
			return `https://${resource}.openai.azure.com`;
		}
		case "canopywave":
			return "https://inference.canopywave.io";
		case "custom":
			throw new Error(`Custom provider requires a baseUrl`);
		default:
			throw new Error(`Provider ${provider} requires a baseUrl`);
	}
}

export function getVideoProviderEndpoint(
	provider: ProviderId,
	baseUrl?: string,
	model?: string,
	token?: string,
	providerKeyOptions?: ProviderKeyOptions,
	configIndex?: number,
): string {
	let modelName = model;
	if (model && model !== "custom") {
		const modelInfo = models.find((entry) => entry.id === model);
		if (modelInfo) {
			const providerMapping = modelInfo.providers.find(
				(entry) => entry.providerId === provider,
			);
			if (providerMapping) {
				modelName = providerMapping.modelName;
			}
		}
	}

	const url = resolveProviderBaseUrl(
		provider,
		baseUrl,
		configIndex,
		undefined,
		providerKeyOptions,
		model,
	);

	switch (provider) {
		case "tuzi":
		case "openai":
			return `${url}/v1/videos`;
		case "google-ai-studio": {
			const baseEndpoint = modelName
				? `${url}/v1beta/models/${modelName}:predictLongRunning`
				: `${url}/v1beta/models/veo-3.1-generate-preview:predictLongRunning`;
			return token ? `${baseEndpoint}?key=${token}` : baseEndpoint;
		}
		case "google-vertex": {
			const videoModel = modelName ?? "veo-3.1-generate-preview";
			const projectId =
				providerKeyOptions?.google_vertex_project ??
				getProviderEnvValue("google-vertex", "project", configIndex);
			const region =
				providerKeyOptions?.google_vertex_region ??
				getProviderEnvValue(
					"google-vertex",
					"region",
					configIndex,
					"us-central1",
				) ??
				"us-central1";

			if (!projectId) {
				const vertexEnv = getProviderEnvConfig("google-vertex");
				throw new Error(
					`${vertexEnv?.required.project ?? "LLM_GOOGLE_CLOUD_PROJECT"} is required for Vertex model "${videoModel}" (set via provider options or environment variable)`,
				);
			}

			const baseEndpoint = `${url}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${videoModel}:predictLongRunning`;
			return token ? `${baseEndpoint}?key=${token}` : baseEndpoint;
		}
		default:
			throw new Error(
				`Video generation endpoint is not configured for provider ${provider}`,
			);
	}
}

/**
 * Get the endpoint URL for a provider API call
 */
export function getProviderEndpoint(
	provider: ProviderId,
	baseUrl?: string,
	model?: string,
	token?: string,
	stream?: boolean,
	supportsReasoning?: boolean,
	hasExistingToolCalls?: boolean,
	providerKeyOptions?: ProviderKeyOptions,
	configIndex?: number,
	imageGenerations?: boolean,
): string {
	let modelName = model;
	if (model && model !== "custom") {
		const modelInfo = models.find((m) => m.id === model);
		if (modelInfo) {
			const providerMapping = modelInfo.providers.find(
				(p) => p.providerId === provider,
			);
			if (providerMapping) {
				modelName = providerMapping.modelName;
			}
		}
	}
	const url = resolveProviderBaseUrl(
		provider,
		baseUrl,
		configIndex,
		imageGenerations,
		providerKeyOptions,
		model,
	);

	if (!url) {
		throw new Error(`Failed to determine base URL for provider ${provider}`);
	}

	switch (provider) {
		case "anthropic":
			return `${url}/v1/messages`;
		case "google-ai-studio": {
			const endpoint = stream ? "streamGenerateContent" : "generateContent";
			const baseEndpoint = modelName
				? `${url}/v1beta/models/${modelName}:${endpoint}`
				: `${url}/v1beta/models/gemini-2.0-flash:${endpoint}`;
			const queryParams = [];
			if (token) {
				queryParams.push(`key=${token}`);
			}
			if (stream) {
				queryParams.push("alt=sse");
			}
			return queryParams.length > 0
				? `${baseEndpoint}?${queryParams.join("&")}`
				: baseEndpoint;
		}
		case "obsidian": {
			const endpoint = stream ? "streamGenerateContent" : "generateContent";
			const baseEndpoint = modelName
				? `${url}/v1beta/models/${modelName}:${endpoint}`
				: `${url}/v1beta/models/gemini-3-pro-image-preview:${endpoint}`;
			const queryParams = [];
			if (stream) {
				queryParams.push("alt=sse");
			}
			return queryParams.length > 0
				? `${baseEndpoint}?${queryParams.join("&")}`
				: baseEndpoint;
		}
		case "google-vertex": {
			const endpoint = stream ? "streamGenerateContent" : "generateContent";
			const model = modelName ?? "gemini-2.5-flash-lite";

			// Special handling for some models which require a non-global location
			let baseEndpoint: string;
			if (
				model === "gemini-2.0-flash-lite" ||
				model === "gemini-2.5-flash-lite"
			) {
				baseEndpoint = `${url}/v1/publishers/google/models/${model}:${endpoint}`;
			} else {
				const projectId =
					providerKeyOptions?.google_vertex_project ??
					getProviderEnvValue("google-vertex", "project", configIndex);

				const region =
					providerKeyOptions?.google_vertex_region ??
					getProviderEnvValue(
						"google-vertex",
						"region",
						configIndex,
						"global",
					) ??
					"global";

				if (!projectId) {
					const vertexEnv = getProviderEnvConfig("google-vertex");
					throw new Error(
						`${vertexEnv?.required.project ?? "LLM_GOOGLE_CLOUD_PROJECT"} is required for Vertex model "${model}" (set via provider options or environment variable)`,
					);
				}

				baseEndpoint = `${url}/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${endpoint}`;
			}

			const queryParams = [];
			if (token) {
				queryParams.push(`key=${token}`);
			}
			if (stream) {
				queryParams.push("alt=sse");
			}
			return queryParams.length > 0
				? `${baseEndpoint}?${queryParams.join("&")}`
				: baseEndpoint;
		}
		case "perplexity":
			return `${url}/chat/completions`;
		case "novita":
			return `${url}/chat/completions`;
		case "zai":
			if (imageGenerations) {
				return `${url}/api/paas/v4/images/generations`;
			}
			return `${url}/api/paas/v4/chat/completions`;
		case "aws-bedrock": {
			const prefix =
				providerKeyOptions?.aws_bedrock_region_prefix ??
				getProviderEnvValue("aws-bedrock", "region", configIndex, "global.") ??
				"global.";

			const endpoint = stream ? "converse-stream" : "converse";
			return `${url}/model/${prefix}${modelName}/${endpoint}`;
		}
		case "azure": {
			const deploymentType =
				providerKeyOptions?.azure_deployment_type ??
				getProviderEnvValue(
					"azure",
					"deploymentType",
					configIndex,
					"ai-foundry",
				) ??
				"ai-foundry";

			if (deploymentType === "openai") {
				// Traditional Azure (deployment-based)
				const apiVersion =
					providerKeyOptions?.azure_api_version ??
					getProviderEnvValue(
						"azure",
						"apiVersion",
						configIndex,
						"2024-10-21",
					) ??
					"2024-10-21";

				return `${url}/openai/deployments/${modelName}/chat/completions?api-version=${apiVersion}`;
			} else {
				// Azure AI Foundry (unified endpoint)
				const useResponsesApiEnv = getProviderEnvValue(
					"azure",
					"useResponsesApi",
					configIndex,
					"true",
				);

				if (model && useResponsesApiEnv !== "false") {
					const modelDef = models.find(
						(m) =>
							m.id === model ||
							m.providers.some(
								(p) => p.modelName === model && p.providerId === "azure",
							),
					);
					const providerMapping = modelDef?.providers.find(
						(p) => p.providerId === "azure",
					);
					const supportsResponsesApi =
						(providerMapping as ProviderModelMapping)?.supportsResponsesApi ===
						true;

					if (supportsResponsesApi) {
						return `${url}/openai/v1/responses`;
					}
				}
				return `${url}/openai/v1/chat/completions`;
			}
		}
		case "openai": {
			if (imageGenerations) {
				return `${url}/images/generations`;
			}
			if (supportResponsesApi(provider, model)) {
				return `${url}/v1/responses`;
			}
			return `${url}/v1/chat/completions`;
		}
		case "alibaba":
			if (imageGenerations) {
				return `${url}/api/v1/services/aigc/multimodal-generation/generation`;
			}
			if (supportResponsesApi(provider, model)) {
				return `${url}/v1/responses`;
			}
			return `${url}/v1/chat/completions`;
		case "bytedance":
			if (imageGenerations) {
				return `${url}/images/generations`;
			}
			if (supportResponsesApi(provider, model)) {
				return `${url}/responses`;
			}
			return `${url}/chat/completions`;
		case "xai":
			if (imageGenerations) {
				return `${url}/v1/images/generations`;
			}
			return `${url}/v1/chat/completions`;
		case "inference.net":
		case "llmgateway":
		case "tuzi":
		case "groq":
		case "cerebras":
		case "deepseek":
		case "moonshot":
		case "nebius":
		case "nanogpt":
		case "canopywave":
		case "minimax":
		case "custom":
		default:
			return `${url}/v1/chat/completions`;
	}
}
