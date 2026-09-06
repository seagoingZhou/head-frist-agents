/**
 * ModelRegistry —— Phase-0 骨架(同名最小版)。
 *
 * 对应生产 model-registry.ts;教学首版只给 AgentSession 认证用的两个口:
 *   getApiKeyAndHeaders(model) / isUsingOAuth(model)
 * 真实 token 解析(按 provider 从 env/配置取 key、OAuth 流程)TODO 后续补实现。
 */
import type { Model } from "pi-ai";

export interface ApiKeyResult {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	error?: string;
}

export interface ModelRegistryOptions {
	/** 按 provider 显式给 key(测试/教学用;真实场景从环境变量取) */
	apiKeys?: Record<string, string>;
}

export class ModelRegistry {
	private _apiKeys: Record<string, string>;

	constructor(options?: ModelRegistryOptions) {
		this._apiKeys = options?.apiKeys ?? {};
	}

	async getApiKeyAndHeaders(model: Model<any>): Promise<ApiKeyResult> {
		// TODO(后续实现): 按 provider 从 this._apiKeys / process.env 取 key;mock provider 直接给空 key
		const key = this._apiKeys[model.provider];
		if (key) {
			return { ok: true, apiKey: key, env: { provider: model.provider } };
		}
		return { ok: false, error: "No API key found" };
	}

	isUsingOAuth(_model: Model<any>): boolean {
		// TODO(后续实现): 生产 OAuth 判定
		return false;
	}
}