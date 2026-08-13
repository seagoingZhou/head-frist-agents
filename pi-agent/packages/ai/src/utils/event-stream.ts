import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";


export class EventStream<T, R = T> implements AsyncIterable<T>{

    private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

    constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

    async *[Symbol.asyncIterator](): AsyncIterator<T> {

        // 实现异步迭代器逻辑
        // 这里可以根据具体需求进行实现，例如从某个数据源中获取数据并 yield 出去
        // 下面是一个简单的示例，假设我们有一个异步生成器函数 generateData() 来生成数据
        // for await (const item of this.generateData()) {
        //     yield item;
        // }
    }

	push(event: T): void {
		// 
	}

	end(result?: R): void {
		
	}

    result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
	
}