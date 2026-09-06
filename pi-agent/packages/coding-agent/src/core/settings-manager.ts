/**
 * SettingsManager —— Phase-0 骨架(同名最小版)。
 *
 * 对应生产 settings-manager.ts;教学首版只要 AgentSession 用到的两个读口:
 *   getCompactionSettings() / getRetrySettings()
 * 构造允许注入(测试/运行时可控),后续再补各 settings 子域与写入方法。
 */
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction/compaction.ts";

/** 重试设置(教学最小形;生产另有 maxRetries 语义细化) */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
}

export interface SettingsManagerOptions {
	compactionSettings?: CompactionSettings;
	retrySettings?: RetrySettings;
}

export class SettingsManager {
	private _compaction: CompactionSettings;
	private _retry: RetrySettings;

	constructor(options?: SettingsManagerOptions) {
		this._compaction = options?.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS;
		this._retry = options?.retrySettings ?? { enabled: false, maxRetries: 3 };
	}

	getCompactionSettings(): CompactionSettings {
		return this._compaction;
	}

	getRetrySettings(): RetrySettings {
		return this._retry;
	}

	//// TODO(后续): setAutoCompactionEnabled / setAutoRetryEnabled / 生产完整 settings 面
}