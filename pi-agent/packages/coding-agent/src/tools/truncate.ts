/**
 * 工具输出的通用截断工具(上下文工程"输入侧 ① 减法",见 plans/05 §四)。
 *
 * 双重限制,先触者胜:
 * - 行数上限(缺省 2000 行)——管"展示可读性"
 * - 字节上限(缺省 50KB)——管"硬性体积"(防 minified 单行把窗口撑爆)
 *
 * 除非截尾的兜底分支(单行超限时取该行末尾),否则不返回半截的行。
 */

// 默认行数上限:防行数过多(管可读性)
export const DEFAULT_MAX_LINES = 2000;
// 默认字节上限 50KB:管硬性体积
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
// grep 单行限长:压缩 JS/minified 可能一行几万字符,截到 500 字符
export const GREP_MAX_LINE_LENGTH = 500; // grep 命中行的最大字符数

/**
 * 截断结果的完整元信息——截断是有损的,但绝不偷偷干:
 * 把"截了没、由哪个限制触发、原始多大、输出多大"全部告诉下游,
 * 下游据此在结果后追加"[Showing ... Full output: ...]"这类逃生提示。
 */
export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 命中的限制:"lines" | "bytes",未截断为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容总行数 */
	totalLines: number;
	/** 原始内容总字节数 */
	totalBytes: number;
	/** 截断输出中的完整行数 */
	outputLines: number;
	/** 截断输出中的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断(仅截尾"单行超限取行尾"的兜底,其余恒 false) */
	lastLinePartial: boolean;
	/** 首行是否单独就超字节上限(仅截头;此时 content 为空) */
	firstLineExceedsLimit: boolean;
	/** 实际应用的行数上限 */
	maxLines: number;
	/** 实际应用的字节上限 */
	maxBytes: number;
}

export interface TruncationOptions {
	/** 行数上限(缺省 2000) */
	maxLines?: number;
	/** 字节上限(缺省 50KB) */
	maxBytes?: number;
}

/** 拆行做"计数"用:尾随换行产生的空段不算一行。 */
function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop(); // 丢掉末尾换行的空段(文件以 \n 结尾时不该多算一行)
	}
	return lines;
}

/** 把字节数格式化成人类可读(B/KB/MB,KB/MB 保留一位小数)。 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头截断(保留开头 N 行/字节)——用于 read 文件:文件头部(import/类定义/接口签名)信息密度最高。
 *
 * 不返回半截的行。若首行单独就超字节上限,返回空 content 并置 firstLineExceedsLimit=true。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 没超任何限制 → 原样返回,不截断(双限制都达标)
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 首行单独就超字节上限:截头留不出"完整行"了 → 返回空 content,置 firstLineExceedsLimit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// 从前往后收集放得下的完整行(行数/字节双限制并行检查,任一触发即停)
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 是换行符占的字节

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 若是撞行数上限退出(字节没超),明确标成 "lines"
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从末尾截断(保留末尾 N 行/字节)——用于 bash 输出:错误堆栈/最终结果都在末尾,信号最强。
 *
 * 若最后一行单独就超字节上限,兜底取该行末尾 maxBytes(置 lastLinePartial=true),不返回空。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 没超任何限制 → 原样返回,不截断(双限制都达标)
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 从末尾往回挑选保留行(unshift 插到头部,保持原顺序)
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 是换行符占的字节

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 兜底:一行都没放进去且这行本身就超限——取该行末尾 maxBytes(部分行),避免结果为空
			// (bash 场景 LLM 至少能看到尾巴的报错行)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 若是撞行数上限退出(字节没超),明确标成 "lines"
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/** 从字符串末尾截取到不超过 maxBytes 的一段——正确处理多字节 UTF-8(不切坏字符,emoji 整体保留或整体丢弃)。 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// 指针从末尾回退 maxBytes 字节,得到"要保留的最后一段"的起点
	let start = buf.length - maxBytes;

	// 前移到合法 UTF-8 边界:值为 0x80..0xBF 的字节是某个多字节字符的"续字节",
	// 从中间切开会得到损坏字符(�),所以要跳过它们直到某个字符的"首字节"。
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/** 把单行截到 maxChars 字符,并加 "... [truncated]" 后缀——用于 grep 命中的超长行(压缩 JS/minified)。 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
