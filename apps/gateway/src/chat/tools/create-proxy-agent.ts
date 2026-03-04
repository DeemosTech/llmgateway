import { HTTPException } from "hono/http-exception";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

import type { InferSelectModel, tables } from "@llmgateway/db";

/**
 * Creates a proxy agent based on the target URL and proxy configuration
 * @param url The target URL to proxy
 * @param useProxy Whether to use a proxy for this request
 * @param providerKey The provider key with proxy configuration (optional)
 * @returns Proxy agent if needed, undefined otherwise
 */
export function createProxyAgent(
	url: string,
	useProxy: boolean,
	providerKey?: InferSelectModel<typeof tables.providerKey>,
): HttpProxyAgent<any> | HttpsProxyAgent<any> | undefined {
	if (!useProxy) {
		return undefined;
	}

	// Get proxy configuration from environment variables
	const targetUrl = new URL(url);
	const isHttps = targetUrl.protocol === "https:";

	let proxyUrl: string | undefined;

	// Try to get provider-specific proxy from provider key options
	if (providerKey?.options?.proxy_url) {
		proxyUrl = providerKey.options.proxy_url;
	} else {
		// Fall back to global proxy configuration
		proxyUrl = isHttps
			? process.env.LLM_HTTPS_PROXY
			: process.env.LLM_HTTP_PROXY;
	}

	// If no proxy configured, return undefined
	if (!proxyUrl) {
		return undefined;
	}

	try {
		// Check if target URL is in no-proxy list
		if (process.env.LLM_NO_PROXY) {
			const noProxyList = process.env.LLM_NO_PROXY.split(",")
				.map((domain) => domain.trim())
				.filter((domain) => domain.length > 0);

			const targetHost = targetUrl.hostname;
			const shouldBypassProxy = noProxyList.some((domain) => {
				if (domain.startsWith(".")) {
					// Domain like .example.com matches example.com and www.example.com
					return targetHost.endsWith(domain) || targetHost === domain.slice(1);
				}
				return targetHost === domain;
			});

			if (shouldBypassProxy) {
				return undefined;
			}
		}

		// Create the appropriate proxy agent
		const proxyUrlObj = new URL(proxyUrl);
		if (proxyUrlObj.protocol === "https:") {
			return new HttpsProxyAgent(proxyUrl);
		} else {
			return new HttpProxyAgent(proxyUrl);
		}
	} catch (error) {
		throw new HTTPException(500, {
			message: "Invalid proxy configuration: " + error,
		});
	}
}
