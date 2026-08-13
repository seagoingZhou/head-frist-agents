import type {
	Api,
    AssistantMessage,
    Context,
    StreamOptions,
} from "./types.ts";

import{ AssistantMessageEventStream } from "./utils/event-stream.ts";

export interface Model<TApi extends Api>{
    id: string;
	name: string;
	api: TApi;
}

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};


const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}


export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream {
	
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}