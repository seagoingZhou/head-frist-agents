import type { 
    AssistantMessage, 
    Context, 
    Model,
    StreamFunction,
    StreamOptions
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";


export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	return stream;
};