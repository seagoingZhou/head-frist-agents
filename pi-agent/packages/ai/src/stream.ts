import { 
    AssistantMessageEventStream 
} from "./utils/event-stream.ts";
import type { 
    Api, 
    Model, 
    Context,
    SimpleStreamOptions,
    KnownProvider,
    OptionsForApi
} from "./types.ts";
import { 
    type OpenAICompletionsOptions, 
    streamOpenAICompletions 
} from "./providers/openai-completions.ts";
import {
    streamMock 
    } from "./providers/mock.ts";


/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: any): string | undefined {

    // mock provider 不需要真实 key，但要让下游通用的 key 检查通过
	if (provider === "mock") {
		return "mock-key";
	}
    
	// Fall back to environment variables
	if (provider === "github-copilot") {
		return process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	}

	// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY
	if (provider === "anthropic") {
		return process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
	}

	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		google: "GEMINI_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		zai: "ZAI_API_KEY",
		mistral: "MISTRAL_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? process.env[envVar] : undefined;
}




export function streamSimple<TApi extends Api>(
    Model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions
): AssistantMessageEventStream {
    const apiKey = options?.apikey || getEnvApiKey(Model.provider);
    if (!apiKey) {
        throw new Error(`No API key for provider: ${Model.provider}`);
    }
    const providerOptions = { ...options, apikey: apiKey };
    return stream(Model, context, providerOptions as OptionsForApi<TApi>);

}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	const apiKey = options?.apikey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	const providerOptions = { ...options, apiKey };

	const api: Api = model.api;
	switch (api) {
		// case "anthropic-messages":
		// 	return streamAnthropic(model as Model<"anthropic-messages">, context, providerOptions);

		case "openai-completions":
			return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);


		// case "openai-responses":
		// 	return streamOpenAIResponses(model as Model<"openai-responses">, context, providerOptions as any);

		// case "google-generative-ai":
		// 	return streamGoogle(model as Model<"google-generative-ai">, context, providerOptions);

		// case "google-gemini-cli":
		// 	return streamGoogleGeminiCli(
		// 		model as Model<"google-gemini-cli">,
		// 		context,
		// 		providerOptions as GoogleGeminiCliOptions,
		// 	);

        case "mock":
            return streamMock(model as Model<"mock">, context, providerOptions as OptionsForApi<"mock">);

		default: {
			// This should never be reached if all Api cases are handled
			const _exhaustive: never = api;
			throw new Error(`Unhandled API: ${_exhaustive}`);
		}
	}
}

